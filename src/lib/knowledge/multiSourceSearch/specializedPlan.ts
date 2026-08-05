/**
 * Spezialisierte Suchpläne nach Primäranker-Erkennung.
 */
import type {
  MultiSourceId,
  MultiSourceSearchPlan,
  PrimaryAnchor,
  SearchPlanType,
  SpecializedSearchPlan,
  StageEvidenceItem,
} from "@/lib/knowledge/multiSourceSearch/types";

export const MASTER_FIELD_STEPS = [
  "load_field_definition",
  "load_field_values",
  "extract_key_contexts",
  "find_exact_code_usage",
  "find_related_control_tables",
  "extract_control_values",
  "follow_calls_and_relations",
  "build_process_evidence",
] as const;

export const CONTROL_TABLE_STEPS = [
  "load_control_table_definition",
  "extract_control_values",
  "find_exact_code_usage",
  "follow_calls_and_relations",
  "build_process_evidence",
] as const;

export const GENERIC_STEPS = [
  "broad_concept_search",
  "expand_anchors",
  "synthesize",
] as const;

export const TECHNICAL_SYMBOL_STEPS = [
  "extract_technical_symbols",
  "exact_symbol_search_canonical",
  "set_technical_symbol_primary",
  "expand_object_metadata",
  "follow_calls_and_relations",
  "discard_unrelated_semantic_hits",
  "build_process_evidence",
] as const;

export function buildSpecializedPlan(params: {
  plan: MultiSourceSearchPlan;
  primaryAnchor: PrimaryAnchor | null;
  planType: SearchPlanType;
}): SpecializedSearchPlan {
  if (params.planType === "TECHNICAL_SYMBOL_TO_PROCESS" && params.primaryAnchor) {
    const sym = params.primaryAnchor.symbol ?? params.primaryAnchor.table;
    return {
      plan_type: "TECHNICAL_SYMBOL_TO_PROCESS",
      primary_anchor: params.primaryAnchor,
      steps: [...TECHNICAL_SYMBOL_STEPS],
      focused_stage_order: [
        "exact_symbol",
        "programs",
        "function_modules",
        "classes",
        "relations",
        "control_tables",
      ],
      abort_broad_search: true,
      notes: [
        `Technischer Primäranker: ${sym}`,
        `Objekte: ${(params.primaryAnchor.objects ?? []).slice(0, 8).join(", ")}`,
        "Semantische Treffer ohne Relation zu diesen Objekten werden verworfen.",
      ],
    };
  }

  if (params.planType === "MASTER_FIELD_TO_PROCESS" && params.primaryAnchor) {
    return {
      plan_type: "MASTER_FIELD_TO_PROCESS",
      primary_anchor: params.primaryAnchor,
      steps: [...MASTER_FIELD_STEPS],
      focused_stage_order: [
        "exact_symbol",
        "control_tables",
        "classes",
        "programs",
        "function_modules",
        "relations",
      ],
      abort_broad_search: true,
      notes: [
        `Primäranker: ${params.primaryAnchor.table}-${params.primaryAnchor.field}`,
        "Breite Konzept-Suche deaktiviert — fokussierte Folgeabfragen.",
      ],
    };
  }

  if (params.planType === "CONTROL_TABLE_TO_PROCESS" && params.primaryAnchor) {
    return {
      plan_type: "CONTROL_TABLE_TO_PROCESS",
      primary_anchor: params.primaryAnchor,
      steps: [...CONTROL_TABLE_STEPS],
      focused_stage_order: [
        "exact_symbol",
        "classes",
        "programs",
        "function_modules",
        "control_tables",
        "relations",
      ],
      abort_broad_search: true,
      notes: [
        `Steuertabellen-Anker: ${params.primaryAnchor.table}`,
        "Fokus auf Tabellenzugriffe und Codepfade.",
      ],
    };
  }

  return {
    plan_type: "GENERIC",
    primary_anchor: null,
    steps: [...GENERIC_STEPS],
    focused_stage_order: [...params.plan.source_order],
    abort_broad_search: false,
    notes: ["Kein Primäranker — generischer Multi-Source-Plan."],
  };
}

export function buildFocusedQueries(params: {
  specialized: SpecializedSearchPlan;
  valueNeedles: string[];
  keyNeedles: string[];
}): string[] {
  const anchor = params.specialized.primary_anchor;
  if (!anchor) return [];

  const queries: string[] = [];
  const table = anchor.table;
  const field = anchor.field;

  if (field) {
    queries.push(field);
    queries.push(`${table}-${field}`);
    queries.push(`${table}.${field}`);
    queries.push(`SELECT ${field} FROM ${table}`);
    queries.push(`IF ${table}-${field}`);
    queries.push(`tables_read ${table}`);
    queries.push(`fields_read ${field}`);

    for (const v of params.valueNeedles.slice(0, 6)) {
      if (v.length <= 40) {
        queries.push(`${field} = '${v}'`);
        queries.push(`${field} ${v}`);
        queries.push(`${table}-${field} = '${v}'`);
      }
    }
    for (const k of params.keyNeedles.slice(0, 4)) {
      queries.push(k);
    }
  } else if (table) {
    queries.push(table);
    queries.push(`FROM ${table}`);
    queries.push(`tables_read ${table}`);
    for (const v of params.valueNeedles.slice(0, 4)) {
      queries.push(`${table} ${v}`);
    }
  }

  return [...new Set(queries.map((q) => q.trim()).filter((q) => q.length >= 2))].slice(
    0,
    14,
  );
}

export function stageOrderForRun(
  plan: MultiSourceSearchPlan,
  specialized: SpecializedSearchPlan,
  round: number,
): MultiSourceId[] {
  if (round === 1) {
    return plan.source_order;
  }
  return specialized.focused_stage_order ?? plan.source_order;
}

export type PrimaryAnchorCoverage = {
  has_field_definition: boolean;
  has_value_analysis: boolean;
  has_code_usage_or_none_reported: boolean;
  checked_control_tables: boolean;
  checked_relations: boolean;
  sufficient: boolean;
  missing: string[];
};

export function evaluatePrimaryAnchorCoverage(
  stages: { stage: MultiSourceId; hits: StageEvidenceItem[] }[],
  specialized: SpecializedSearchPlan,
): PrimaryAnchorCoverage {
  const anchor = specialized.primary_anchor;
  const missing: string[] = [];

  const mdHits = stages
    .filter((s) => s.stage === "master_data")
    .flatMap((s) => s.hits);
  const hasFieldDef =
    mdHits.some(
      (h) =>
        h.evidence_type === "MASTER_DATA_BUSINESS_FIELD" ||
        (h.field_name && h.rank_tier === "exact"),
    ) || anchor?.anchor_type === "MASTER_DATA_BUSINESS_FIELD";

  const hasValues = mdHits.some(
    (h) => h.evidence_type === "MASTER_DATA_BUSINESS_VALUE" || h.id.startsWith("md-values:"),
  );

  const codeStages: MultiSourceId[] = [
    "exact_symbol",
    "classes",
    "programs",
    "function_modules",
  ];
  const codeHits = stages
    .filter((s) => codeStages.includes(s.stage))
    .flatMap((s) => s.hits);
  const hasCode =
    codeHits.some((h) => h.rank_tier === "exact" || h.evidence_type === "EXACT_CODE_USAGE");
  const codeStagesRun = stages.some((s) => codeStages.includes(s.stage));

  const ctRun = stages.some((s) => s.stage === "control_tables");
  const relRun = stages.some((s) => s.stage === "relations");

  if (specialized.plan_type === "TECHNICAL_SYMBOL_TO_PROCESS" && anchor) {
    if (!hasCode) missing.push("exact_symbol_objects");
    if (!relRun) missing.push("relations_check");
  } else if (specialized.plan_type === "MASTER_FIELD_TO_PROCESS" && anchor) {
    if (!hasFieldDef) missing.push("field_definition");
    if (!hasValues) missing.push("value_analysis");
    if (!codeStagesRun) missing.push("code_usage_check");
    if (!ctRun) missing.push("control_tables_check");
    if (!relRun) missing.push("relations_check");
  }

  const sufficient =
    specialized.plan_type === "GENERIC" ||
    specialized.plan_type === "TECHNICAL_SYMBOL_TO_PROCESS"
      ? hasCode && (relRun || codeStagesRun)
      : hasFieldDef &&
        hasValues &&
        (hasCode || codeStagesRun) &&
        ctRun &&
        relRun;

  return {
    has_field_definition: hasFieldDef,
    has_value_analysis: hasValues,
    has_code_usage_or_none_reported: hasCode || codeStagesRun,
    checked_control_tables: ctRun,
    checked_relations: relRun,
    sufficient,
    missing,
  };
}
