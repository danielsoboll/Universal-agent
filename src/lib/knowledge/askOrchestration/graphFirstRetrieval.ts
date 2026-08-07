/**
 * Graph-first retrieval: seeds → KG hops → cached analyses.
 * Semantic/hybrid search is only a supplement after graph.
 */
import { existsSync } from "fs";
import { BOUND_DATA_PROJECT_KEY } from "@/lib/localData/boundProject";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  loadClassAnalysesMap,
  loadCodeUnitIndex,
  loadKnowledgeGraph,
} from "@/lib/knowledge/graphSelector/loadGraph";
import { selectCodeUnitsFromGraph } from "@/lib/knowledge/graphSelector/selectCodeUnits";
import type { GraphSelectorResult } from "@/lib/knowledge/graphSelector/types";
import { expandRelations } from "@/lib/knowledge/anchorRag/relationExpansion";
import type { AskIntentClassification } from "./classifyAskIntent";
import type { EvidenceBudget } from "./evidenceBudget";

export type GraphFirstRetrieval = {
  seeds: string[];
  graph_paths: Array<{
    source_key: string;
    object_name: string;
    unit_name: string;
    distance: number;
    path_relations: string[];
    cache_status: string;
    would_need_openai: boolean;
  }>;
  cached_analyses: Array<{
    source_key: string;
    object_name: string;
    unit_name: string;
    summary: string | null;
    cache_hit: boolean;
  }>;
  relation_hops: {
    nodes: number;
    edges: number;
    seeds_used: string[];
    hops: number;
  } | null;
  authoritative_nodes: string[];
  code_usage_nodes: string[];
  canonical_sources: string[];
  selector: GraphSelectorResult | null;
  new_analyses_attempted: number;
  duration_ms: number;
};

function asSummary(analysis: Record<string, unknown> | undefined): string | null {
  if (!analysis) return null;
  const tryStr = (obj: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 500);
    }
    return null;
  };
  const keys = [
    "summary",
    "purpose",
    "business_meaning",
    "short_summary",
    "description",
    "responsibility",
  ];
  const direct = tryStr(analysis, keys);
  if (direct) return direct;
  const nested = analysis.analysis;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const inner = tryStr(nested as Record<string, unknown>, keys);
    if (inner) return inner;
  }
  const steps =
    analysis.process_steps ??
    analysis.steps ??
    (nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).process_steps
      : undefined);
  if (Array.isArray(steps) && steps.length) {
    return steps
      .slice(0, 4)
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join(" → ")
      .slice(0, 500);
  }
  return null;
}

export async function runGraphFirstRetrieval(params: {
  question: string;
  intent: AskIntentClassification;
  budget: EvidenceBudget;
  projectKey?: string;
}): Promise<GraphFirstRetrieval> {
  const started = Date.now();
  const projectKey = params.projectKey?.trim() || BOUND_DATA_PROJECT_KEY;
  const seeds = [
    ...new Set([
      ...params.intent.technical_symbols,
      ...params.intent.lexical_seeds.map((s) => s.toUpperCase()),
    ]),
  ].slice(0, 20);

  const canonical_sources: string[] = [];
  const kgPath = resolveProjectZonePath(
    projectKey,
    "canonical",
    "knowledge-graph",
    "graph.jsonl",
  );
  // graph may live under analyses or indexes — loadKnowledgeGraph resolves
  void kgPath;

  let selector: GraphSelectorResult | null = null;
  let relation_hops: GraphFirstRetrieval["relation_hops"] = null;
  const authoritative_nodes: string[] = [];
  const code_usage_nodes: string[] = [];

  try {
    const [graph, codeUnits] = await Promise.all([
      loadKnowledgeGraph(projectKey),
      loadCodeUnitIndex(projectKey, { includeSourceCode: false }),
    ]);
    const analyses = loadClassAnalysesMap(projectKey);
    canonical_sources.push(
      "canonical/knowledge-graph (via loadKnowledgeGraph)",
      "canonical/classes|programs|function-modules (code unit index)",
      "analyses/classes/unit_analyses.jsonl",
    );

    for (const [, node] of graph.nodes) {
      const nameU = node.name.toUpperCase();
      if (!seeds.some((s) => nameU.includes(s) || s.includes(nameU))) continue;
      if (node.authoritative_existence) {
        authoritative_nodes.push(`${node.object_type}:${node.name}`);
      }
      if (node.code_usage) {
        code_usage_nodes.push(`${node.object_type}:${node.name}`);
      }
    }

    if (seeds.length > 0) {
      selector = selectCodeUnitsFromGraph({
        projectKey,
        question: params.question,
        anchors: seeds,
        maxHops: 2,
        maxCodeUnits: 80,
        graph,
        codeUnits,
        analyses,
      });
      // Prefer units that match the most specific seeds (longest first),
      // so "Lager"/"Virtuel" outrank broad tokens like customer names.
      if (selector && selector.selected.length > 0) {
        const specific = [...seeds].sort((a, b) => b.length - a.length);
        const scored = selector.selected.map((u) => {
          const hay = `${u.object_name}|${u.unit_name}|${u.source_key}`.toUpperCase();
          let spec = 0;
          let hits = 0;
          for (const s of specific) {
            if (hay.includes(s.toUpperCase())) {
              spec += Math.min(s.length, 12);
              hits += 1;
            }
          }
          // Multi-seed overlap (e.g. VIRTUEL + LAGER) beats single broad token
          spec += hits * 20;
          return { u, spec };
        });
        scored.sort((a, b) => b.spec - a.spec || a.u.rank - b.u.rank);
        const reRanked = scored.slice(0, 30).map((x, i) => ({
          ...x.u,
          rank: i + 1,
        }));
        selector = { ...selector, selected: reRanked };
      }
    }

    if (seeds.length > 0) {
      try {
        const exp = await expandRelations({
          projectKey,
          seeds,
          maxHops: 2,
          focused: true,
        });
        relation_hops = {
          nodes: exp.nodes.length,
          edges: exp.edges.length,
          seeds_used: exp.seeds_used,
          hops: exp.hops,
        };
        const relPaths = [
          "canonical/message-idoc-config/relations.jsonl",
          "canonical/repository-relations/relations.jsonl",
          "canonical/classes/relations.jsonl",
        ];
        for (const p of relPaths) {
          const abs = resolveProjectZonePath(
            projectKey,
            "canonical",
            ...p.replace(/^canonical\//, "").split("/"),
          );
          if (existsSync(abs)) canonical_sources.push(p);
        }
      } catch {
        // relation expansion optional
      }
    }
  } catch (e) {
    canonical_sources.push(
      `graph_load_error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const graph_paths =
    selector?.selected.map((u) => ({
      source_key: u.source_key,
      object_name: u.object_name,
      unit_name: u.unit_name,
      distance: u.distance,
      path_relations: u.graph_path.map(
        (h) => h.relation_unified || h.relation_type,
      ),
      cache_status: u.cache_status,
      would_need_openai: u.would_need_openai,
    })) ?? [];

  const cached_analyses: GraphFirstRetrieval["cached_analyses"] = [];
  if (selector) {
    const analyses = loadClassAnalysesMap(projectKey);
    for (const u of selector.selected) {
      if (u.cache_status !== "hit" && !analyses.has(u.source_key)) continue;
      const rec = analyses.get(u.source_key);
      cached_analyses.push({
        source_key: u.source_key,
        object_name: u.object_name,
        unit_name: u.unit_name,
        summary: asSummary(rec),
        cache_hit: u.cache_status === "hit",
      });
    }
  }

  // Do not mass-analyze: only count how many would be candidates (cap reported).
  const new_analyses_attempted = Math.min(
    params.budget.max_new_analyses,
    selector?.selected.filter((u) => u.would_need_openai).length ?? 0,
  );

  return {
    seeds,
    graph_paths,
    cached_analyses,
    relation_hops,
    authoritative_nodes: [...new Set(authoritative_nodes)].slice(0, 40),
    code_usage_nodes: [...new Set(code_usage_nodes)].slice(0, 40),
    canonical_sources: [...new Set(canonical_sources)],
    selector,
    new_analyses_attempted,
    duration_ms: Date.now() - started,
  };
}
