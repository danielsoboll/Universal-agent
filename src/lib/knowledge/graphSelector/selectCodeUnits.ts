/**
 * Deterministic Knowledge-Graph → prioritized source_key selector.
 * Diagnostic only — does not call OpenAI or mutate analyses.
 */
import {
  evaluateUnitAnalysisCache,
  type UnitAnalysisCacheDecision,
} from "@/lib/analysis/unitAnalysisCache";
import {
  UNIT_ANALYSIS_PROMPT_VERSION,
  UNIT_ANALYSIS_SCHEMA_VERSION,
  unitAnalysisRecordSchema,
} from "@/lib/analysis/unitAnalysisSchema";
import { AI_CONFIG } from "@/lib/ai/config";
import { hashUnitContent } from "@/lib/analysis/analyzeCodeUnits";
import {
  extractTechnicalSymbols,
} from "@/lib/search/technicalSymbols";
import type { CodeUnitIndex, LoadedGraph } from "@/lib/knowledge/graphSelector/loadGraph";
import type {
  CodeUnitRef,
  EvidenceCoverage,
  GraphEdge,
  GraphNode,
  GraphPathHop,
  GraphSelectorResult,
  SelectedCodeUnit,
} from "@/lib/knowledge/graphSelector/types";

const CODE_NODE_TYPES = new Set([
  "METHOD",
  "PROGRAM",
  "FUNCTION_MODULE",
  "FORM_ROUTINE",
  "CLASS",
  "INCLUDE",
  "CLASS_METHOD_SYMBOL",
]);

const CONFIG_NODE_TYPES = new Set([
  "OUTPUT_TYPE",
  "OUTPUT_TYPE_TEXT",
  "OUTPUT_PROCESSING",
  "CONDITION_TYPE",
  "PRICING_CONDITION_TYPE",
  "MESSAGE_TYPE",
  "IDOC_TYPE",
  "PROCESS_CODE",
  "PARTNER_PROFILE",
]);

const DDIC_NODE_TYPES = new Set([
  "TABLE",
  "TABLE_FIELD",
  "DATA_ELEMENT",
  "DOMAIN",
  "STRUCTURE",
  "VIEW",
]);

const DEFAULT_MAX_HOPS = 2;
const DEFAULT_MAX_CODE_UNITS = 30;

function evidenceRank(edge: GraphEdge, node: GraphNode): number {
  if (edge.authoritative || edge.evidence_class === "authoritative_existence") {
    return 0;
  }
  if (edge.evidence_class === "authoritative_config") return 1;
  if (node.authoritative_existence) return 1;
  if (edge.evidence_class === "usage_relation") return 2;
  if (edge.evidence_class === "code_usage" || node.code_usage) return 3;
  return 4;
}

function relationRank(relationUnified: string, relationType: string): number {
  const r = `${relationUnified}|${relationType}`.toUpperCase();
  if (r.includes("OUTPUT_TYPE") && (r.includes("PROGRAM") || r.includes("ROUTINE"))) {
    return 0;
  }
  if (r.includes("PROCESSED_BY") || r.includes("CALLS_FUNCTION") || r.includes("CALLS_METHOD")) {
    return 1;
  }
  if (r.includes("USES_") || r.includes("READS_TABLE") || r.includes("WRITES_TABLE")) {
    return 2;
  }
  if (r.includes("HAS_TEXT") || r.includes("ASSIGN") || r.includes("CONTAINS")) {
    return 2;
  }
  // Shared FORM_ROUTINE fan-out is weak evidence for the original symbol.
  if (r.includes("PERFORMS_FORM") || r.includes("CODE_PERFORMS")) {
    return 6;
  }
  if (r.includes("UNRESOLVED")) return 5;
  return 3;
}

function isNoisyMethodSymbol(name: string): boolean {
  const n = name.trim();
  if (n.length > 80) return true;
  if (/\s/.test(n)) return true;
  if (n.includes("(") || n.includes(")")) return true;
  if (n.includes("->") || n.includes("=>")) return true;
  return false;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function collectNeedles(question: string, anchors: string[]): string[] {
  const symbols = extractTechnicalSymbols(question);
  const fromQ = symbols
    .filter(
      (s) =>
        s.kind === "zy_name" ||
        s.kind === "compound_field" ||
        s.kind === "method_path" ||
        (s.kind === "uppercase_token" &&
          (s.norm.startsWith("Z") ||
            s.norm.startsWith("Y") ||
            s.norm.includes("_"))),
    )
    .map((s) => s.norm);
  const fromA = anchors
    .map((a) => a.trim().toUpperCase())
    .filter((a) => a.length >= 2);
  // Drop generic German/noise tokens accidentally uppercased
  const stop = new Set([
    "ZUSAMMEN",
    "PREISFINDUNG",
    "VERWENDET",
    "WOFUR",
    "WOFÜR",
    "MACHT",
    "HANGET",
    "HÄNGT",
  ]);
  return [...new Set([...fromQ, ...fromA])].filter((n) => !stop.has(n));
}

function tokenContains(haystack: string, needle: string): boolean {
  const h = haystack.toUpperCase();
  const n = needle.toUpperCase();
  if (!h || !n) return false;
  if (h === n) return true;
  if (n.length < 3) return false;
  const parts = h.split(/[^A-Z0-9]+/).filter(Boolean);
  if (parts.includes(n)) return true;
  if (h.includes(`_${n}_`) || h.startsWith(`${n}_`) || h.endsWith(`_${n}`)) {
    return true;
  }
  if (h.includes(`|${n}|`) || h.endsWith(`|${n}`) || h.startsWith(`${n}|`)) {
    return true;
  }
  return false;
}

function nodeMatchesNeedle(node: GraphNode, needle: string): boolean {
  const n = needle.toUpperCase();
  if (!n) return false;
  if (tokenContains(node.name, n)) return true;
  if (tokenContains(stripQuotes(node.name), n)) return true;
  if (tokenContains(node.identity_key, n)) return true;
  if (node.display_names.some((d) => tokenContains(d, n))) return true;
  for (const v of Object.values(node.attributes)) {
    if (typeof v === "string" && tokenContains(v, n)) return true;
  }
  return false;
}

function findSeeds(
  graph: LoadedGraph,
  needles: string[],
): Array<{ node: GraphNode; match: string }> {
  const out: Array<{ node: GraphNode; match: string }> = [];
  const seen = new Set<string>();

  for (const needle of needles) {
    for (const node of graph.nodes.values()) {
      if (!nodeMatchesNeedle(node, needle)) continue;
      // Prefer non-noisy code / config / ddic
      if (
        node.object_type === "METHOD_SYMBOL" ||
        (node.object_type === "CLASS_METHOD_SYMBOL" &&
          isNoisyMethodSymbol(node.name))
      ) {
        continue;
      }
      if (seen.has(node.node_id)) continue;
      seen.add(node.node_id);
      out.push({ node, match: needle });
    }
  }

  // Prefer authoritative / config / exact code objects first
  out.sort((a, b) => {
    const score = (n: GraphNode) => {
      let s = 0;
      if (n.authoritative_existence) s -= 100;
      if (CONFIG_NODE_TYPES.has(n.object_type)) s -= 50;
      if (CODE_NODE_TYPES.has(n.object_type)) s -= 30;
      if (DDIC_NODE_TYPES.has(n.object_type)) s -= 20;
      return s;
    };
    return score(a.node) - score(b.node);
  });

  return out;
}

type Reach = {
  node_id: string;
  seed_id: string;
  distance: number;
  path: GraphPathHop[];
  best_edge: GraphEdge | null;
};

const WEAK_EXPANSION_RELATIONS = new Set([
  "CODE_PERFORMS_FORM_ROUTINE",
  "PROGRAM_CONTAINS_INCLUDE",
]);

function expandFromSeeds(
  graph: LoadedGraph,
  seeds: Array<{ node: GraphNode; match: string }>,
  maxHops: number,
): Map<string, Reach> {
  const best = new Map<string, Reach>();
  type QueueItem = Reach;
  const queue: QueueItem[] = [];

  for (const s of seeds) {
    const r: Reach = {
      node_id: s.node.node_id,
      seed_id: s.node.node_id,
      distance: 0,
      path: [],
      best_edge: null,
    };
    best.set(s.node.node_id, r);
    queue.push(r);
  }

  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++]!;
    if (cur.distance >= maxHops) continue;
    const edges = graph.adjacency.get(cur.node_id) ?? [];
    for (const edge of edges) {
      const relKey = (edge.relation_unified || edge.relation_type).toUpperCase();
      if (
        WEAK_EXPANSION_RELATIONS.has(relKey) ||
        WEAK_EXPANSION_RELATIONS.has(edge.relation_type.toUpperCase())
      ) {
        // Still record the neighbor at this hop for coverage, but do not
        // expand further through weak shared-form fan-out.
        const nextId =
          edge.from_node_id === cur.node_id
            ? edge.to_node_id
            : edge.from_node_id;
        if (!graph.nodes.has(nextId)) continue;
        if (best.has(nextId)) continue;
        const hop: GraphPathHop = {
          via_edge_id: edge.edge_id,
          relation_type: edge.relation_type,
          relation_unified: edge.relation_unified,
          evidence_class: edge.evidence_class,
          occurrence_count: edge.occurrence_count,
          from_node_id: edge.from_node_id,
          to_node_id: edge.to_node_id,
        };
        best.set(nextId, {
          node_id: nextId,
          seed_id: cur.seed_id,
          distance: cur.distance + 1,
          path: [...cur.path, hop],
          best_edge: edge,
        });
        continue;
      }
      const nextId =
        edge.from_node_id === cur.node_id
          ? edge.to_node_id
          : edge.from_node_id;
      if (!graph.nodes.has(nextId)) continue;
      const hop: GraphPathHop = {
        via_edge_id: edge.edge_id,
        relation_type: edge.relation_type,
        relation_unified: edge.relation_unified,
        evidence_class: edge.evidence_class,
        occurrence_count: edge.occurrence_count,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
      };
      const next: Reach = {
        node_id: nextId,
        seed_id: cur.seed_id,
        distance: cur.distance + 1,
        path: [...cur.path, hop],
        best_edge: edge,
      };
      const prev = best.get(nextId);
      if (!prev || next.distance < prev.distance) {
        best.set(nextId, next);
        queue.push(next);
      } else if (
        prev &&
        next.distance === prev.distance &&
        evidenceRank(edge, graph.nodes.get(nextId)!) <
          evidenceRank(
            prev.best_edge ?? edge,
            graph.nodes.get(nextId)!,
          )
      ) {
        best.set(nextId, next);
      }
    }
  }

  return best;
}

function mapNodeToCodeUnits(
  node: GraphNode,
  index: CodeUnitIndex,
): CodeUnitRef[] {
  const out: CodeUnitRef[] = [];
  const seen = new Set<string>();
  const add = (refs: CodeUnitRef[] | undefined) => {
    if (!refs) return;
    for (const r of refs) {
      if (seen.has(r.source_key)) continue;
      seen.add(r.source_key);
      out.push(r);
    }
  };

  const name = stripQuotes(node.name).toUpperCase();
  const identity = node.identity_key.toUpperCase();

  if (node.object_type === "METHOD" || node.object_type === "CLASS_METHOD_SYMBOL") {
    if (identity.includes("|")) {
      add(index.byClassMethod.get(identity));
      const parts = identity.split("|");
      if (parts.length >= 2) {
        add(index.byClassMethod.get(`${parts[0]}|${parts[parts.length - 1]}`));
      }
    }
    add(index.byUnitName.get(name));
  } else if (node.object_type === "CLASS") {
    add(index.byObjectName.get(name));
  } else if (
    node.object_type === "PROGRAM" ||
    node.object_type === "INCLUDE"
  ) {
    // Only object-level units — do not fan out via shared FORM names.
    const refs = index.byObjectName.get(name) ?? [];
    add(refs.filter((r) => r.unit_type === "PROGRAM" || r.unit_type === "INCLUDE" || r.object_name.toUpperCase() === name));
  } else if (node.object_type === "FORM_ROUTINE") {
    add(index.byUnitName.get(name));
  } else if (node.object_type === "FUNCTION_MODULE") {
    add(index.byObjectName.get(name));
    add(index.byUnitName.get(name));
  } else if (node.object_type === "TABLE" || DDIC_NODE_TYPES.has(node.object_type)) {
    // DDIC seed alone does not map to code units here — filled by corpus scan.
  }

  return out;
}

/** Exact / token-safe code-unit seeds from corpora (not graph hops). */
function findDirectCorpusRefs(
  index: CodeUnitIndex,
  needles: string[],
): Array<{ ref: CodeUnitRef; match: string }> {
  const out: Array<{ ref: CodeUnitRef; match: string }> = [];
  const seen = new Set<string>();
  for (const ref of index.bySourceKey.values()) {
    for (const needle of needles) {
      if (
        tokenContains(ref.object_name, needle) ||
        tokenContains(ref.unit_name, needle) ||
        tokenContains(ref.source_key, needle)
      ) {
        if (seen.has(ref.source_key)) break;
        seen.add(ref.source_key);
        out.push({ ref, match: needle });
        break;
      }
    }
  }
  return out;
}

/**
 * Field-like needles often appear only inside source_code, not in unit names.
 * Cap hits to keep selection focused.
 */
function findSourceCodeRefs(
  index: CodeUnitIndex,
  needles: string[],
  cap = 40,
): Array<{ ref: CodeUnitRef; match: string }> {
  const fieldNeedles = needles.filter(
    (n) => n.includes("_") || n.includes("-") || n.length >= 6,
  );
  if (fieldNeedles.length === 0) return [];
  const out: Array<{ ref: CodeUnitRef; match: string }> = [];
  const seen = new Set<string>();
  for (const ref of index.bySourceKey.values()) {
    if (!ref.source_code) continue;
    const upper = ref.source_code.toUpperCase();
    for (const needle of fieldNeedles) {
      const n = needle.replace(/-/g, "~").toUpperCase(); // KNVV-ZZ_VLAGER → also try ~
      const plain = needle.toUpperCase();
      if (upper.includes(plain) || (n !== plain && upper.includes(n))) {
        if (seen.has(ref.source_key)) break;
        seen.add(ref.source_key);
        out.push({ ref, match: needle });
        break;
      }
    }
    if (out.length >= cap) break;
  }
  return out;
}

function directSymbolScore(
  ref: CodeUnitRef,
  needles: string[],
  distance: number,
): number {
  if (distance === 0) return 0;
  const o = ref.object_name.toUpperCase();
  const u = ref.unit_name.toUpperCase();
  for (const n of needles) {
    if (o === n || u === n) return 0;
    if (o.includes(n) || u.includes(n)) return 1;
  }
  return distance >= 2 ? 3 : 2;
}

function evaluateCacheForRef(
  ref: CodeUnitRef,
  analyses: Map<string, Record<string, unknown>>,
): {
  decision: UnitAnalysisCacheDecision;
  already_analyzed: boolean;
  cache_status: SelectedCodeUnit["cache_status"];
  would_need_openai: boolean;
  openai_eligible: boolean;
} {
  if (ref.corpus !== "classes" || ref.unit_type !== "METHOD") {
    return {
      decision: {
        hit: false,
        reason: "missing",
        key: {
          source_key: ref.source_key,
          content_hash: "",
          source_hash: "",
          prompt_version: UNIT_ANALYSIS_PROMPT_VERSION,
          model: AI_CONFIG.chatModel,
          model_version: AI_CONFIG.chatModel,
          analysis_schema_version: UNIT_ANALYSIS_SCHEMA_VERSION,
        },
      },
      already_analyzed: false,
      cache_status: "not_in_class_corpus",
      would_need_openai: false,
      openai_eligible: false,
    };
  }

  const raw = analyses.get(ref.source_key);
  const parsed = raw ? unitAnalysisRecordSchema.safeParse(raw) : null;
  const existing = parsed?.success ? parsed.data : undefined;
  const contentHash =
    ref.content_hash ??
    (ref.source_code ? hashUnitContent(ref.source_code) : undefined) ??
    existing?.content_hash ??
    "";

  if (!contentHash && !existing) {
    return {
      decision: {
        hit: false,
        reason: "missing",
        key: {
          source_key: ref.source_key,
          content_hash: "",
          source_hash: "",
          prompt_version: UNIT_ANALYSIS_PROMPT_VERSION,
          model: AI_CONFIG.chatModel,
          model_version: AI_CONFIG.chatModel,
          analysis_schema_version: UNIT_ANALYSIS_SCHEMA_VERSION,
        },
      },
      already_analyzed: false,
      cache_status: "miss",
      would_need_openai: true,
      openai_eligible: true,
    };
  }

  const decision = evaluateUnitAnalysisCache({
    existing,
    source_key: ref.source_key,
    contentHash: contentHash || "missing-hash",
    promptVersion: UNIT_ANALYSIS_PROMPT_VERSION,
    model: AI_CONFIG.chatModel,
    analysisSchemaVersion: UNIT_ANALYSIS_SCHEMA_VERSION,
  });

  if (decision.hit) {
    return {
      decision,
      already_analyzed: true,
      cache_status: "hit",
      would_need_openai: false,
      openai_eligible: true,
    };
  }

  if (!existing) {
    return {
      decision,
      already_analyzed: false,
      cache_status: "miss",
      would_need_openai: true,
      openai_eligible: true,
    };
  }

  return {
    decision,
    already_analyzed: true,
    cache_status: "stale",
    would_need_openai: true,
    openai_eligible: true,
  };
}

export type SelectCodeUnitsParams = {
  projectKey: string;
  question: string;
  anchors?: string[];
  maxHops?: number;
  maxCodeUnits?: number;
  graph: LoadedGraph;
  codeUnits: CodeUnitIndex;
  analyses: Map<string, Record<string, unknown>>;
};

export function selectCodeUnitsFromGraph(
  params: SelectCodeUnitsParams,
): GraphSelectorResult {
  const maxHops = params.maxHops ?? DEFAULT_MAX_HOPS;
  const maxCodeUnits = params.maxCodeUnits ?? DEFAULT_MAX_CODE_UNITS;
  const anchors = params.anchors ?? [];
  const needles = collectNeedles(params.question, anchors);
  const seeds = findSeeds(params.graph, needles);
  const reached = expandFromSeeds(params.graph, seeds, maxHops);

  type Cand = {
    ref: CodeUnitRef;
    reach: Reach;
    node: GraphNode;
    score: SelectedCodeUnit["score_components"];
    ranking_reason: string;
  };

  const candidates: Cand[] = [];
  const seenKeys = new Set<string>();

  // 1) Direct corpus symbol seeds (safe exact/token matches)
  const directHits = [
    ...findDirectCorpusRefs(params.codeUnits, needles),
    ...findSourceCodeRefs(params.codeUnits, needles),
  ];
  for (const direct of directHits) {
    if (seenKeys.has(direct.ref.source_key)) continue;
    seenKeys.add(direct.ref.source_key);
    const auth = 0;
    const directScore = 0;
    const rel = 0;
    const occ = 99;
    const dist = 0;
    const total =
      auth * 1000 + directScore * 100 + rel * 20 + dist * 10 - Math.min(occ, 50);
    candidates.push({
      ref: direct.ref,
      reach: {
        node_id: `CORPUS|${direct.ref.source_key}`,
        seed_id: `CORPUS|${direct.match}`,
        distance: 0,
        path: [],
        best_edge: null,
      },
      node: {
        node_id: `CORPUS|${direct.ref.source_key}`,
        object_type: direct.ref.object_type || direct.ref.unit_type,
        name: direct.ref.unit_name,
        identity_key: direct.ref.source_key,
        system_id: "",
        display_names: [],
        authoritative_existence: false,
        code_usage: true,
        attributes: {},
      },
      score: {
        authoritative: auth,
        direct_symbol: directScore,
        relation_type: rel,
        occurrence_count: occ,
        distance: dist,
        total,
      },
      ranking_reason: direct.ref.source_code &&
      !tokenContains(direct.ref.object_name, direct.match) &&
      !tokenContains(direct.ref.unit_name, direct.match)
        ? `direct_source_symbol; match=${direct.match}; distance=0`
        : `direct_corpus_symbol; match=${direct.match}; distance=0`,
    });
  }

  for (const reach of reached.values()) {
    const node = params.graph.nodes.get(reach.node_id);
    if (!node) continue;
    if (!CODE_NODE_TYPES.has(node.object_type)) continue;
    if (
      node.object_type === "CLASS_METHOD_SYMBOL" &&
      isNoisyMethodSymbol(node.name)
    ) {
      continue;
    }

    const refs = mapNodeToCodeUnits(node, params.codeUnits);
    // CLASS seed with many methods: keep only those matching needles in unit/object
    const filtered =
      node.object_type === "CLASS" && refs.length > 20
        ? refs.filter((r) =>
            needles.some(
              (n) =>
                r.unit_name.toUpperCase().includes(n) ||
                r.object_name.toUpperCase() === n,
            ),
          )
        : refs;

    for (const ref of filtered) {
      if (seenKeys.has(ref.source_key)) continue;
      // Drop weak shared-FORM fan-out into unrelated class methods.
      // Keep program/FM object units reached via FORM (e.g. Z_RVADIN01 ← GET_ZRAH_PRICE).
      const edgeRel = (reach.best_edge?.relation_unified ||
        reach.best_edge?.relation_type ||
        "").toUpperCase();
      if (
        reach.distance > 0 &&
        ref.corpus === "classes" &&
        (edgeRel.includes("PERFORMS_FORM") || edgeRel.includes("CODE_PERFORMS")) &&
        directSymbolScore(ref, needles, reach.distance) > 1
      ) {
        continue;
      }
      seenKeys.add(ref.source_key);

      const edge = reach.best_edge;
      const auth = edge ? evidenceRank(edge, node) : node.authoritative_existence ? 0 : 4;
      const direct = directSymbolScore(ref, needles, reach.distance);
      const rel = edge
        ? relationRank(edge.relation_unified, edge.relation_type)
        : reach.distance === 0
          ? 0
          : 4;
      const occ = edge ? edge.occurrence_count : 1;
      const dist = reach.distance;
      // Lower total is better
      const total =
        auth * 1000 +
        direct * 100 +
        rel * 20 +
        dist * 10 -
        Math.min(occ, 50);

      const ranking_reason = [
        auth === 0 ? "authoritative_evidence" : `evidence_rank=${auth}`,
        direct === 0 ? "direct_symbol" : `symbol_rank=${direct}`,
        edge
          ? `relation=${edge.relation_unified || edge.relation_type}`
          : "seed_node",
        `occurrence=${occ}`,
        `distance=${dist}`,
      ].join("; ");

      candidates.push({
        ref,
        reach,
        node,
        score: {
          authoritative: auth,
          direct_symbol: direct,
          relation_type: rel,
          occurrence_count: occ,
          distance: dist,
          total,
        },
        ranking_reason,
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.score.total !== b.score.total) return a.score.total - b.score.total;
    return a.ref.source_key.localeCompare(b.ref.source_key);
  });

  const selectedRaw = candidates.slice(0, maxCodeUnits);
  const heldRaw = candidates.slice(maxCodeUnits);

  const toSelected = (
    c: Cand,
    rank: number,
    duplicate: boolean,
  ): SelectedCodeUnit => {
    const cache = evaluateCacheForRef(c.ref, params.analyses);
    return {
      rank,
      source_key: c.ref.source_key,
      corpus: c.ref.corpus,
      object_name: c.ref.object_name,
      unit_name: c.ref.unit_name,
      unit_type: c.ref.unit_type,
      seed_node_id: c.reach.seed_id,
      graph_node_id: c.node.node_id,
      graph_object_type: c.node.object_type,
      distance: c.reach.distance,
      graph_path: c.reach.path,
      ranking_reason: c.ranking_reason,
      score_components: c.score,
      already_analyzed: cache.already_analyzed,
      duplicate,
      cache_status: duplicate ? "duplicate" : cache.cache_status,
      cache_reason: cache.decision.hit
        ? "cache_hit"
        : cache.decision.reason,
      would_need_openai: duplicate ? false : cache.would_need_openai,
      openai_eligible: cache.openai_eligible,
    };
  };

  const seenOut = new Set<string>();
  const selected: SelectedCodeUnit[] = [];
  for (let i = 0; i < selectedRaw.length; i++) {
    const c = selectedRaw[i]!;
    const dup = seenOut.has(c.ref.source_key);
    seenOut.add(c.ref.source_key);
    selected.push(toSelected(c, i + 1, dup));
  }

  const held_back = heldRaw.map((c, i) =>
    toSelected(c, maxCodeUnits + i + 1, false),
  );

  const authConfig = [...reached.values()].filter((r) => {
    const n = params.graph.nodes.get(r.node_id);
    return n && (CONFIG_NODE_TYPES.has(n.object_type) || n.authoritative_existence);
  }).length;

  const codeReached = [...reached.values()].filter((r) => {
    const n = params.graph.nodes.get(r.node_id);
    return n && CODE_NODE_TYPES.has(n.object_type);
  }).length;

  const ddic = [...reached.values()].filter((r) => {
    const n = params.graph.nodes.get(r.node_id);
    return n && DDIC_NODE_TYPES.has(n.object_type);
  }).length;

  const gaps: string[] = [];
  if (seeds.length === 0) gaps.push("no_safe_seeds_for_anchors");
  if (authConfig === 0) gaps.push("no_authoritative_config_in_hops");
  if (codeReached === 0) gaps.push("no_code_nodes_in_hops");
  if (selected.length === 0) gaps.push("no_mappable_code_units");

  const needing = selected.filter((s) => s.would_need_openai).length;
  const hits = selected.filter((s) => s.cache_status === "hit").length;

  // Expansion past 30 only after coverage check — never automatic.
  let expansion = false;
  let expansionReason: string | null = null;
  if (
    held_back.length > 0 &&
    (gaps.includes("no_authoritative_config_in_hops") ||
      (needing === 0 && hits === 0 && selected.length < 3) ||
      (codeReached > maxCodeUnits && selected.filter((s) => s.openai_eligible).length < 3))
  ) {
    expansion = true;
    expansionReason =
      "Coverage-Lücken bei Cap=30 — manuelle Erweiterung prüfen (nicht auto).";
  }

  const evidence_coverage: EvidenceCoverage = {
    seeds_found: seeds.length,
    seeds_requested: needles,
    authoritative_config_nodes: authConfig,
    code_nodes_reached: codeReached,
    selected_code_units: selected.length,
    selected_with_cache_hit: hits,
    selected_needing_openai: needing,
    held_back_over_cap: held_back.length,
    ddic_or_table_nodes: ddic,
    expansion_over_cap_recommended: expansion,
    expansion_reason: expansionReason,
    gaps,
  };

  return {
    question: params.question,
    anchors,
    max_hops: maxHops,
    max_code_units: maxCodeUnits,
    seeds: seeds.map((s) => ({
      node_id: s.node.node_id,
      object_type: s.node.object_type,
      name: s.node.name,
      match: s.match,
      authoritative_existence: s.node.authoritative_existence,
    })),
    selected,
    held_back,
    evidence_coverage,
    stats: {
      nodes_loaded: params.graph.nodes.size,
      edges_loaded: params.graph.edges.length,
      code_units_indexed: params.codeUnits.bySourceKey.size,
      candidates_before_cap: candidates.length,
    },
  };
}
