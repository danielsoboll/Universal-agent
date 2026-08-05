/**
 * Stages D–E — Programs / Function modules via canonical extracts (streaming).
 * Not in hybrid index — skip with diagnosis when missing.
 */
import { existsSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  AnchorSet,
  makeAnchor,
} from "@/lib/knowledge/multiSourceSearch/anchors";
import { primaryAnchorNeedles } from "@/lib/knowledge/multiSourceSearch/primaryAnchor";
import { buildFocusedQueries } from "@/lib/knowledge/multiSourceSearch/specializedPlan";
import {
  asString,
  streamJsonlObjects,
  textMatchesAny,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import type {
  MultiSourceId,
  MultiSourceSearchPlan,
  SourceCoverage,
  SpecializedSearchPlan,
  StageEvidenceItem,
  StageResult,
} from "@/lib/knowledge/multiSourceSearch/types";

function listFields(rec: Record<string, unknown>): string[] {
  const fields = rec.fields;
  if (!Array.isArray(fields)) return [];
  return fields.map((f) => asString(f)).filter(Boolean);
}

function listStrings(rec: Record<string, unknown>, key: string): string[] {
  const v = rec[key];
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter(Boolean);
}

async function runExtractStage(params: {
  stage: "programs" | "function_modules";
  projectKey: string;
  plan: MultiSourceSearchPlan;
  anchors: AnchorSet;
  coverage: SourceCoverage;
  round: number;
  relativeExtractPath: string[];
  specialized?: SpecializedSearchPlan;
}): Promise<StageResult> {
  const started = Date.now();
  const queries: StageResult["queries"] = [];
  const hits: StageEvidenceItem[] = [];
  const newAnchors = [];

  if (!params.coverage.exists) {
    return {
      stage: params.stage,
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
      why_next: `${params.stage} nicht durchsuchbar.`,
      abort: true,
      abort_reason: params.coverage.diagnosis,
      coverage: params.coverage,
      duration_ms: Date.now() - started,
    };
  }

  const abs = resolveProjectZonePath(
    params.projectKey,
    "canonical",
    ...params.relativeExtractPath,
  );
  if (!existsSync(abs)) {
    return {
      stage: params.stage,
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
      why_next: "Extract-Datei fehlt.",
      abort: true,
      abort_reason: `Erwartet: canonical/${params.relativeExtractPath.join("/")}`,
      coverage: params.coverage,
      duration_ms: Date.now() - started,
    };
  }

  const strong = params.anchors.strongNeedles();
  const structural = [
    ...params.anchors.valuesOfKinds(["field", "table", "object", "symbol"]),
  ].filter((n) => n.length >= 4);
  const primaryNeedles = params.specialized?.primary_anchor
    ? primaryAnchorNeedles(params.specialized.primary_anchor)
    : [];
  const focusedQueries =
    params.specialized?.abort_broad_search && params.specialized.primary_anchor
      ? buildFocusedQueries({
          specialized: params.specialized,
          valueNeedles: params.anchors.valuesOfKinds(["value"]),
          keyNeedles: params.anchors.valuesOfKinds(["key"]),
        })
      : [];
  // Concept synonyms only as weak fallback when no structural anchors yet
  const conceptFallback =
    strong.length + structural.length === 0 && !params.specialized?.abort_broad_search
      ? params.plan.synonym_candidates.filter((s) => s.length >= 5)
      : [];
  const uniqueNeedles = [
    ...new Set(
      [...primaryNeedles, ...focusedQueries, ...strong, ...structural, ...conceptFallback]
        .map((n) => n.trim())
        .filter((n) => n.length >= 3 && !/^[XYN]$/i.test(n) && !/^\d+$/.test(n)),
    ),
  ];

  let scanned = 0;
  let matchedCount = 0;
  for await (const rec of streamJsonlObjects(abs)) {
    scanned += 1;
    if (matchedCount >= 20) break;
    const object_name = asString(rec.object_name);
    const unit_name = asString(rec.unit_name);
    const tables = [
      ...listStrings(rec, "tables_read"),
      ...listStrings(rec, "tables_written"),
      ...listStrings(rec, "tables_zy"),
    ];
    const fields = listFields(rec);
    const hardcoded = listStrings(rec, "hardcoded_values");
    const calls = [
      ...listStrings(rec, "call_function"),
      ...listStrings(rec, "call_method"),
      ...listStrings(rec, "submit"),
    ];
    const blob = [
      object_name,
      unit_name,
      tables.join(" "),
      fields.join(" "),
      hardcoded.join(" "),
      calls.join(" "),
    ].join(" ");
    const matched = textMatchesAny(blob, uniqueNeedles);
    if (!matched) continue;

    // Ranking: exact symbol/table/field > value in hardcoded > weak concept
    const upperMatched = matched.toUpperCase();
    const exact =
      primaryNeedles.some((p) => blob.toUpperCase().includes(p.toUpperCase())) ||
      tables.some((t) => t.toUpperCase() === upperMatched) ||
      fields.some((f) => f.toUpperCase().includes(upperMatched)) ||
      object_name.toUpperCase() === upperMatched;
    const valueHit = hardcoded.some((h) =>
      h.toUpperCase().includes(upperMatched),
    );

    matchedCount += 1;
    hits.push({
      id: `${params.stage}:${asString(rec.unit_key) || `${object_name}.${unit_name}`}`,
      source: params.stage,
      rank_tier: exact ? "exact" : valueHit ? "value_check" : "semantic_weak",
      evidence_type: exact ? "EXACT_CODE_USAGE" : valueHit ? "EXACT_VALUE_CONDITION" : undefined,
      title: `${object_name} · ${unit_name || asString(rec.unit_type)}`,
      summary: [
        tables.slice(0, 8).length
          ? `Tabellen: ${tables.slice(0, 8).join(", ")}`
          : null,
        fields.slice(0, 6).length
          ? `Felder: ${fields.slice(0, 6).join(", ")}`
          : null,
        calls.slice(0, 4).length ? `Calls: ${calls.slice(0, 4).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      object_name: object_name || undefined,
      anchors_matched: [matched],
      confidence: exact ? 0.88 : valueHit ? 0.72 : 0.45,
      path_hint: `canonical/${params.relativeExtractPath.join("/")}`,
      raw_excerpt: blob.slice(0, 280),
    });

    if (object_name) {
      newAnchors.push(
        makeAnchor({
          kind: "object",
          value: object_name,
          source: params.stage,
          confidence: 0.8,
        }),
      );
    }
    for (const t of tables.slice(0, 6)) {
      if (/^[ZY]/i.test(t)) {
        newAnchors.push(
          makeAnchor({
            kind: "table",
            value: t,
            source: params.stage,
            confidence: 0.7,
          }),
        );
      }
    }
    for (const f of fields.slice(0, 8)) {
      const fieldPart = f.includes("-") ? f.split("-").pop()! : f;
      if (/^[ZY]/i.test(fieldPart)) {
        newAnchors.push(
          makeAnchor({
            kind: "field",
            value: fieldPart,
            source: params.stage,
            confidence: 0.65,
          }),
        );
      }
    }
  }

  queries.push({
    query: uniqueNeedles.slice(0, 12).join(" | "),
    purpose: "canonical_extracts_stream",
    hit_count: matchedCount,
  });

  const confidence =
    hits.length === 0
      ? 0.1
      : Math.min(
          0.9,
          0.35 +
            hits.filter((h) => h.rank_tier === "exact").length * 0.08 +
            hits.filter((h) => h.rank_tier === "value_check").length * 0.04,
        );

  return {
    stage: params.stage,
    round: params.round,
    inputs: {
      anchors: params.anchors.strongNeedles(),
      concepts: params.plan.concepts,
      synonyms: params.plan.synonym_candidates,
    },
    queries,
    hits,
    new_anchors: newAnchors.filter(Boolean) as NonNullable<
      ReturnType<typeof makeAnchor>
    >[],
    confidence,
    why_next:
      params.stage === "programs"
        ? "Function Modules mit denselben Ankern."
        : "Relations-Expansion mit neuen Ankern.",
    abort: false,
    coverage: params.coverage,
    duration_ms: Date.now() - started,
  };
}

export async function runProgramsStage(params: {
  projectKey: string;
  plan: MultiSourceSearchPlan;
  anchors: AnchorSet;
  coverage: SourceCoverage;
  round: number;
  specialized?: SpecializedSearchPlan;
}): Promise<StageResult> {
  return runExtractStage({
    ...params,
    stage: "programs",
    relativeExtractPath: ["programs", "extracts.jsonl"],
  });
}

export async function runFunctionModulesStage(params: {
  projectKey: string;
  plan: MultiSourceSearchPlan;
  anchors: AnchorSet;
  coverage: SourceCoverage;
  round: number;
  specialized?: SpecializedSearchPlan;
}): Promise<StageResult> {
  return runExtractStage({
    ...params,
    stage: "function_modules",
    relativeExtractPath: ["function-modules", "extracts.jsonl"],
  });
}

export type ExtractStageId = Extract<
  MultiSourceId,
  "programs" | "function_modules"
>;
