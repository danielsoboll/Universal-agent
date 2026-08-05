/**
 * Stage C — Classes: hybrid code_unit + streamed unit analyses / canonical units.
 */
import { existsSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import { KnowledgeRetriever } from "@/lib/knowledge/knowledgeRetriever";
import type { LocalProject } from "@/lib/localAuth/types";
import {
  AnchorSet,
  makeAnchor,
} from "@/lib/knowledge/multiSourceSearch/anchors";
import { primaryAnchorNeedles } from "@/lib/knowledge/multiSourceSearch/primaryAnchor";
import { buildFocusedQueries } from "@/lib/knowledge/multiSourceSearch/specializedPlan";
import {
  asString,
  flattenStringValues,
  streamJsonlObjects,
  textMatchesAny,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import type {
  MultiSourceSearchPlan,
  SourceCoverage,
  SpecializedSearchPlan,
  StageEvidenceItem,
  StageResult,
} from "@/lib/knowledge/multiSourceSearch/types";

function buildQueries(
  plan: MultiSourceSearchPlan,
  anchors: AnchorSet,
  specialized?: SpecializedSearchPlan,
): string[] {
  if (specialized?.abort_broad_search && specialized.primary_anchor) {
    const focused = buildFocusedQueries({
      specialized,
      valueNeedles: anchors.valuesOfKinds(["value"]),
      keyNeedles: anchors.valuesOfKinds(["key"]),
    });
    if (focused.length > 0) return focused.slice(0, 10);
  }

  const strong = anchors.strongNeedles();
  const fields = anchors.valuesOfKinds(["field"]);
  const tables = anchors.valuesOfKinds(["table"]).filter((t) =>
    /^[ZY]/i.test(t),
  );
  const qs: string[] = [];
  if (strong.length) qs.push(strong.slice(0, 6).join(" "));
  for (const f of fields.slice(0, 4)) qs.push(f);
  for (const t of tables.slice(0, 4)) qs.push(t);
  const concept = plan.concepts.filter((c) => c.length >= 4).slice(0, 4).join(" ");
  if (concept && !specialized?.abort_broad_search) qs.push(concept);
  return [...new Set(qs.map((q) => q.trim()).filter(Boolean))].slice(0, 8);
}

export async function runClassesStage(params: {
  projectKey: string;
  project: LocalProject;
  plan: MultiSourceSearchPlan;
  anchors: AnchorSet;
  coverage: SourceCoverage;
  round: number;
  specialized?: SpecializedSearchPlan;
}): Promise<StageResult> {
  const started = Date.now();
  const queriesLog: StageResult["queries"] = [];
  const hits: StageEvidenceItem[] = [];
  const newAnchors = [];
  const seen = new Set<string>();
  const structural = params.anchors
    .valuesOfKinds(["field", "table", "object", "symbol"])
    .filter((n) => n.length >= 4);
  const primaryNeedles = params.specialized?.primary_anchor
    ? primaryAnchorNeedles(params.specialized.primary_anchor)
    : [];
  const needles = [
    ...primaryNeedles,
    ...params.anchors.strongNeedles(),
    ...structural,
    ...(structural.length === 0 && !params.specialized?.abort_broad_search
      ? params.plan.synonym_candidates.filter((s) => s.length >= 5)
      : []),
  ].filter((n) => n.length >= 3 && !/^[XYN]$/i.test(n) && !/^\d+$/.test(n));

  if (!params.coverage.exists) {
    return {
      stage: "classes",
      round: params.round,
      inputs: {
        anchors: params.anchors.strongNeedles(),
        concepts: params.plan.concepts,
        synonyms: params.plan.synonym_candidates,
      },
      queries: [],
      hits: [],
      new_anchors: [],
      confidence: 0,
      why_next: "Klassen-Quellen fehlen.",
      abort: true,
      abort_reason: params.coverage.diagnosis,
      coverage: params.coverage,
      duration_ms: Date.now() - started,
    };
  }

  for (const q of buildQueries(params.plan, params.anchors, params.specialized)) {
    try {
      const result = await KnowledgeRetriever.search({
        project: params.project,
        query: q,
        limit: 8,
        filters: { knowledge_unit_types: ["code_unit"] },
        enableRelationExpansion: true,
      });
      let added = 0;
      for (const hit of result.hits) {
        if (seen.has(hit.search_document_id)) continue;
        const blob = `${hit.title} ${hit.snippet ?? ""} ${hit.object_name ?? ""} ${hit.subobject_name ?? ""}`;
        const matched = needles.filter((n) =>
          blob.toUpperCase().includes(n.toUpperCase()),
        );
        const strongMatched = matched.filter((m) => m.length >= 5);
        if (needles.length > 0 && strongMatched.length === 0) {
          // Drop weak semantic / short-token only hits (e.g. abapgit noise)
          continue;
        }
        seen.add(hit.search_document_id);
        added += 1;
        hits.push({
          id: `class-hybrid:${hit.search_document_id}`,
          source: "classes",
          rank_tier:
            hit.exact_score > 0
              ? "exact"
              : matched.length > 0
                ? "value_check"
                : "semantic_weak",
          evidence_type:
            hit.exact_score > 0 || primaryNeedles.some((p) =>
              blob.toUpperCase().includes(p.toUpperCase()),
            )
              ? "EXACT_CODE_USAGE"
              : undefined,
          title: hit.title || `${hit.object_name}.${hit.subobject_name}`,
          summary: (hit.technical_summary || hit.snippet || "").slice(
            0,
            400,
          ),
          object_name: hit.object_name || undefined,
          anchors_matched: matched.length ? matched : [q],
          confidence: Math.min(0.92, 0.35 + hit.combined_score / 18),
          path_hint: "indexes/search (code_unit)",
        });
        if (hit.object_name) {
          newAnchors.push(
            makeAnchor({
              kind: "object",
              value: hit.object_name,
              source: "classes",
              confidence: 0.8,
            }),
          );
        }
        for (const t of hit.tables_read ?? []) {
          if (/^[ZY]/i.test(t)) {
            newAnchors.push(
              makeAnchor({
                kind: "table",
                value: t,
                source: "classes",
                confidence: 0.7,
              }),
            );
          }
        }
      }
      queriesLog.push({ query: q, purpose: "hybrid_code_unit", hit_count: added });
    } catch (e) {
      queriesLog.push({
        query: q,
        purpose: `hybrid_error:${e instanceof Error ? e.message : "err"}`,
        hit_count: 0,
      });
    }
  }

  // Stream analyses for exact symbol / field / table matches
  const analysesPath = resolveProjectZonePath(
    params.projectKey,
    "analyses",
    "classes",
    "unit_analyses.jsonl",
  );
  if (existsSync(analysesPath) && needles.length > 0) {
    let scanned = 0;
    let added = 0;
    for await (const rec of streamJsonlObjects(analysesPath)) {
      scanned += 1;
      if (scanned > 50_000 || added >= 16) break;
      const blob = flattenStringValues(rec);
      const matched = textMatchesAny(blob, needles);
      if (!matched) continue;
      const className = asString(rec.class_name);
      const methodName = asString(rec.method_name);
      const id = `class-ana:${asString(rec.source_key) || `${className}.${methodName}`}`;
      if (seen.has(id)) continue;
      seen.add(id);
      added += 1;
      const exact =
        needles.some(
          (n) =>
            className.toUpperCase() === n.toUpperCase() ||
            methodName.toUpperCase() === n.toUpperCase(),
        ) ||
        /^(Z|Y)/i.test(matched);
      hits.push({
        id,
        source: "classes",
        rank_tier: exact ? "exact" : "value_check",
        evidence_type: exact ? "EXACT_CODE_USAGE" : undefined,
        title: `${className}.${methodName}`,
        summary: asString(rec.technical_summary).slice(0, 400),
        object_name: className || undefined,
        anchors_matched: [matched],
        confidence: exact ? 0.9 : 0.7,
        path_hint: "analyses/classes/unit_analyses.jsonl",
        raw_excerpt: asString(rec.search_text).slice(0, 240),
      });
      if (className) {
        newAnchors.push(
          makeAnchor({
            kind: "object",
            value: className,
            source: "classes",
            confidence: 0.85,
          }),
        );
        newAnchors.push(
          makeAnchor({
            kind: "symbol",
            value: `${className}.${methodName}`,
            source: "classes",
            confidence: 0.75,
          }),
        );
      }
    }
    queriesLog.push({
      query: needles.slice(0, 10).join(" | "),
      purpose: "analyses_unit_stream",
      hit_count: added,
    });
  }

  const confidence =
    hits.length === 0
      ? params.coverage.status === "partial"
        ? 0.2
        : 0.1
      : Math.min(0.9, 0.4 + hits.length * 0.04);

  return {
    stage: "classes",
    round: params.round,
    inputs: {
      anchors: params.anchors.strongNeedles(),
      concepts: params.plan.concepts,
      synonyms: params.plan.synonym_candidates,
    },
    queries: queriesLog,
    hits: hits.slice(0, 18),
    new_anchors: newAnchors.filter(Boolean) as NonNullable<
      ReturnType<typeof makeAnchor>
    >[],
    confidence,
    why_next: "Programme/FMs mit bewährten Ankern durchsuchen.",
    abort: false,
    coverage: params.coverage,
    duration_ms: Date.now() - started,
  };
}
