/**
 * Stage B — Control tables: anchored hybrid + streamed row scan.
 * Avoids generic AUART/VKORG searches without concrete values.
 */
import { existsSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  KnowledgeRetriever,
  type KnowledgeHit,
} from "@/lib/knowledge/knowledgeRetriever";
import type { LocalProject } from "@/lib/localAuth/types";
import {
  AnchorSet,
  makeAnchor,
} from "@/lib/knowledge/multiSourceSearch/anchors";
import { primaryAnchorNeedles } from "@/lib/knowledge/multiSourceSearch/primaryAnchor";
import { buildFocusedQueries } from "@/lib/knowledge/multiSourceSearch/specializedPlan";
import {
  asRecord,
  asString,
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

const GENERIC_ONLY = new Set([
  "AUART",
  "VKORG",
  "VTWEG",
  "SPART",
  "WERKS",
  "LGORT",
  "MANDT",
  "BUKRS",
]);

function buildAnchoredQueries(
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
    if (focused.length > 0) return focused;
  }

  const fields = anchors.valuesOfKinds(["field"]);
  const values = anchors.valuesOfKinds(["value"]);
  const tables = anchors.valuesOfKinds(["table"]);
  const keys = anchors.valuesOfKinds(["key"]);
  const strong = anchors.strongNeedles();

  const queries: string[] = [];
  // Field + value combos (concrete steering)
  for (const f of fields.slice(0, 6)) {
    if (GENERIC_ONLY.has(f.toUpperCase()) && values.length === 0) continue;
    if (values.length > 0) {
      for (const v of values.slice(0, 4)) {
        queries.push(`${f} ${v}`);
      }
    } else {
      queries.push(f);
    }
  }
  for (const t of tables.slice(0, 5)) {
    if (/^(MARA|MARC|MARD|KNA1|KNVV)$/i.test(t)) continue; // master tables already covered
    queries.push(t);
  }
  for (const k of keys.slice(0, 4)) queries.push(k);
  // Concept + strongest anchors (not bare AUART) — skip in focused mode
  if (!specialized?.abort_broad_search) {
    const conceptCore = plan.concepts
      .filter((c) => c.length >= 4)
      .slice(0, 3)
      .join(" ");
    if (strong.length > 0) {
      queries.push(`${conceptCore} ${strong.slice(0, 4).join(" ")}`.trim());
    } else if (conceptCore) {
      queries.push(conceptCore);
    }
  }

  return [...new Set(queries.map((q) => q.trim()).filter((q) => q.length >= 2))].slice(
    0,
    14,
  );
}

function hitToEvidence(hit: KnowledgeHit, matched: string[]): StageEvidenceItem {
  const meta = (hit.metadata ?? {}) as Record<string, unknown>;
  const table =
    asString(meta.table_name) ||
    asString(meta.object_name) ||
    hit.title ||
    hit.source_key;
  return {
    id: `ct-hybrid:${hit.search_document_id}`,
    source: "control_tables",
    rank_tier:
      hit.exact_score > 0
        ? "exact"
        : hit.combined_score >= 2
          ? "value_check"
          : "semantic_weak",
    title: hit.title || table,
    summary: (hit.snippet || hit.technical_summary || "").slice(0, 400),
    table_name: table,
    object_name: asString(meta.object_name) || undefined,
    anchors_matched: matched,
    confidence: Math.min(0.95, 0.4 + hit.combined_score / 20),
    path_hint: "indexes/search",
    raw_excerpt: hit.snippet?.slice(0, 240),
  };
}

export async function runControlTablesStage(params: {
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

  if (!params.coverage.exists) {
    return {
      stage: "control_tables",
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
      why_next: "Control Tables nicht verfügbar.",
      abort: true,
      abort_reason: params.coverage.diagnosis,
      coverage: params.coverage,
      duration_ms: Date.now() - started,
    };
  }

  const anchoredQueries = buildAnchoredQueries(
    params.plan,
    params.anchors,
    params.specialized,
  );
  const primaryNeedles =
    params.specialized?.primary_anchor
      ? primaryAnchorNeedles(params.specialized.primary_anchor)
      : [];
  const matchNeedles = [
    ...primaryNeedles,
    ...params.anchors.strongNeedles(),
    ...params.anchors.valuesOfKinds(["field", "value", "table"]),
  ];

  for (const q of anchoredQueries) {
    try {
      const result = await KnowledgeRetriever.search({
        project: params.project,
        query: q,
        limit: 8,
        filters: {
          knowledge_unit_types: [
            "control_table",
            "control_table_row",
            "table_row",
            "table_profile",
            "table_rule_group",
            "business_rule",
            "code_table_interpretation",
          ],
        },
        enableRelationExpansion: false,
      });
      let added = 0;
      for (const hit of result.hits) {
        if (seen.has(hit.search_document_id)) continue;
        const blob = `${hit.title} ${hit.snippet ?? ""} ${hit.source_key}`;
        const matched =
          matchNeedles.length === 0
            ? [q]
            : matchNeedles.filter((n) =>
                blob.toUpperCase().includes(n.toUpperCase()),
              );
        // Prefer hits that touch anchors when we have strong anchors
        if (matchNeedles.length > 0 && matched.length === 0 && hit.exact_score <= 0) {
          continue;
        }
        seen.add(hit.search_document_id);
        hits.push(hitToEvidence(hit, matched.length ? matched : [q]));
        added += 1;

        const meta = (hit.metadata ?? {}) as Record<string, unknown>;
        const tname = asString(meta.table_name) || asString(meta.object_name);
        if (tname && /^[ZY]/i.test(tname)) {
          newAnchors.push(
            makeAnchor({
              kind: "table",
              value: tname,
              source: "control_tables",
              confidence: 0.85,
            }),
          );
        }
      }
      queriesLog.push({ query: q, purpose: "hybrid_anchored_ct", hit_count: added });
    } catch (e) {
      queriesLog.push({
        query: q,
        purpose: `hybrid_error:${e instanceof Error ? e.message : "err"}`,
        hit_count: 0,
      });
    }
  }

  // Stream canonical rows for strong field/value anchors
  const rowsPath = resolveProjectZonePath(
    params.projectKey,
    "canonical",
    "control-tables",
    "table_rows.jsonl",
  );
  const fieldAnchors = params.anchors
    .valuesOfKinds(["field"])
    .filter((f) => f.length >= 4 && !GENERIC_ONLY.has(f.toUpperCase()));
  const zFieldAnchors = fieldAnchors.filter((f) => /^(Z|Y)/i.test(f));
  const valueAnchors = params.anchors
    .valuesOfKinds(["value"])
    .filter((v) => v.length >= 2 && !/^[XYN]$/i.test(v));
  const tableAnchors = params.anchors
    .valuesOfKinds(["table"])
    .filter((t) => /^(Z|Y)/i.test(t));
  if (
    existsSync(rowsPath) &&
    (zFieldAnchors.length > 0 || tableAnchors.length > 0 || valueAnchors.length > 0)
  ) {
    let scanned = 0;
    let rowHits = 0;
    const maxScan = 80_000;
    const preferNeedles = [...zFieldAnchors, ...tableAnchors, ...valueAnchors];
    for await (const rec of streamJsonlObjects(rowsPath)) {
      scanned += 1;
      if (scanned > maxScan || rowHits >= 20) break;
      const table_name = asString(rec.table_name);
      const values = asRecord(rec.values) ?? asRecord(rec.normalized_values);
      if (!values) continue;
      const blob = `${table_name} ${JSON.stringify(values)}`;
      const fieldMatch = textMatchesAny(
        Object.keys(values).join(" "),
        zFieldAnchors.length ? zFieldAnchors : fieldAnchors,
      );
      const tableMatch = textMatchesAny(table_name, tableAnchors);
      const valueMatch = textMatchesAny(blob, preferNeedles);
      const zTable = /^[ZY]/i.test(table_name);
      if (!zTable) continue;
      // Prefer custom-field or Z-table-name hits; value-only only for short non-id values
      if (!fieldMatch && !tableMatch) {
        if (!valueMatch) continue;
        const vm = String(valueMatch);
        if (GENERIC_ONLY.has(vm.toUpperCase())) continue;
        if (vm.length > 12 || /^\d+$/.test(vm)) continue;
      }

      const id = `ct-row:${asString(rec.source_key) || scanned}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rowHits += 1;
      const flatValues: Record<string, string> = {};
      for (const [k, v] of Object.entries(values).slice(0, 12)) {
        flatValues[k] = asString(v).slice(0, 80);
      }
      hits.push({
        id,
        source: "control_tables",
        rank_tier: fieldMatch ? "exact" : "value_check",
        evidence_type: fieldMatch ? "EXACT_VALUE_CONDITION" : undefined,
        title: `${table_name} | ${Object.entries(flatValues)
          .slice(0, 4)
          .map(([k, v]) => `${k}=${v}`)
          .join("|")}`,
        summary: `Steuerzeile ${table_name}`,
        table_name,
        values: flatValues,
        anchors_matched: [fieldMatch, tableMatch, valueMatch].filter(Boolean) as string[],
        confidence: 0.88,
        path_hint: "canonical/control-tables/table_rows.jsonl",
      });
      if (zTable) {
        newAnchors.push(
          makeAnchor({
            kind: "table",
            value: table_name,
            source: "control_tables",
            confidence: 0.9,
          }),
        );
      }
      for (const [k, v] of Object.entries(flatValues)) {
        if (/^(Z|Y)/i.test(k) && v) {
          newAnchors.push(
            makeAnchor({
              kind: "field",
              value: k,
              source: "control_tables",
              confidence: 0.75,
            }),
          );
          newAnchors.push(
            makeAnchor({
              kind: "value",
              value: v,
              source: "control_tables",
              confidence: 0.7,
            }),
          );
        }
      }
    }
    queriesLog.push({
      query: preferNeedles.slice(0, 8).join(" | "),
      purpose: "canonical_rows_stream",
      hit_count: rowHits,
    });
  }

  const confidence =
    hits.length === 0
      ? 0.15
      : Math.min(
          0.95,
          0.45 + hits.filter((h) => h.rank_tier === "exact").length * 0.08,
        );

  return {
    stage: "control_tables",
    round: params.round,
    inputs: {
      anchors: params.anchors.strongNeedles(),
      concepts: params.plan.concepts,
      synonyms: params.plan.synonym_candidates,
    },
    queries: queriesLog,
    hits: hits.slice(0, 24),
    new_anchors: newAnchors.filter(Boolean) as NonNullable<
      ReturnType<typeof makeAnchor>
    >[],
    confidence,
    why_next:
      hits.length > 0
        ? "Tabellen-/Wert-Anker für Klassen/Programme/FMs nutzen."
        : "Schwache CT-Lage — Code-Suche mit Frage-Synonymen + vorhandenen Ankern.",
    abort: false,
    coverage: params.coverage,
    duration_ms: Date.now() - started,
  };
}
