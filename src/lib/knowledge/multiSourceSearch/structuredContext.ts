/**
 * Strukturierter KI-Kontext und Search-Trace aus Run-Ergebnissen.
 */
import type {
  MultiSourceEvidenceBundle,
  MultiSourceSearchPlan,
  PrimaryAnchor,
  SearchPlanType,
  SearchTrace,
  SpecializedSearchPlan,
  StageEvidenceItem,
  StageResult,
  StructuredSearchContext,
} from "@/lib/knowledge/multiSourceSearch/types";
import type { PrimaryAnchorCoverage } from "@/lib/knowledge/multiSourceSearch/specializedPlan";

export function buildStructuredContext(params: {
  question: string;
  specialized: SpecializedSearchPlan;
  evidence: MultiSourceEvidenceBundle;
  stages: StageResult[];
  coverageNotes: Record<string, string>;
  anchorCoverage?: PrimaryAnchorCoverage;
}): StructuredSearchContext {
  const items = params.evidence.items;
  const fieldValues = items
    .filter(
      (i) =>
        i.evidence_type === "MASTER_DATA_BUSINESS_VALUE" ||
        i.id.startsWith("md-values:"),
    )
    .map((i) => ({
      table: i.table_name ?? "",
      field: i.field_name ?? "",
      value_distribution: i.values,
      key_examples: i.keys
        ? [i.keys]
        : i.raw_excerpt
          ? tryParseKeyExamples(i.raw_excerpt)
          : undefined,
    }));

  const keyContexts: Record<string, string>[] = [];
  for (const i of items) {
    if (i.keys) keyContexts.push(i.keys);
    if (i.id.startsWith("md-values:") && i.raw_excerpt) {
      const parsed = tryParseKeyExamples(i.raw_excerpt);
      if (parsed) keyContexts.push(...parsed);
    }
  }

  const controlTables = [
    ...new Set(
      items
        .filter((i) => i.source === "control_tables" && i.table_name)
        .map((i) => i.table_name!),
    ),
  ];

  const controlValues = items
    .filter((i) => i.source === "control_tables" && i.values)
    .slice(0, 12)
    .map((i) => ({
      table: i.table_name ?? "",
      values: i.values ?? {},
    }));

  const classEvidence = items
    .filter((i) => i.source === "classes")
    .slice(0, 10)
    .map((i) => i.title);

  const programEvidence = items
    .filter((i) => i.source === "programs")
    .slice(0, 8)
    .map((i) => i.title);

  const fmEvidence = items
    .filter((i) => i.source === "function_modules")
    .slice(0, 8)
    .map((i) => i.title);

  const relations = items
    .filter((i) => i.source === "relations")
    .slice(0, 12)
    .map((i) => i.title);

  const open_questions: string[] = [];
  if (params.anchorCoverage && !params.anchorCoverage.sufficient) {
    open_questions.push(
      `Primäranker-Abdeckung unvollständig: ${params.anchorCoverage.missing.join(", ")}`,
    );
  }
  const codeHits = items.filter(
    (i) =>
      (i.source === "classes" ||
        i.source === "programs" ||
        i.source === "function_modules") &&
      i.evidence_type === "EXACT_CODE_USAGE",
  );
  if (
    params.specialized.plan_type === "MASTER_FIELD_TO_PROCESS" &&
    codeHits.length === 0
  ) {
    open_questions.push(
      "Keine exakte Codeverwendung des Primäranker-Feldes gefunden (explizit geprüft).",
    );
  }

  return {
    question: params.question,
    plan_type: params.specialized.plan_type,
    primary_anchor: params.specialized.primary_anchor,
    field_values: fieldValues,
    key_contexts: keyContexts.slice(0, 20),
    control_tables: controlTables,
    control_values: controlValues,
    class_evidence: classEvidence,
    program_evidence: programEvidence,
    function_module_evidence: fmEvidence,
    relations,
    coverage: params.coverageNotes,
    open_questions,
    primary_anchor_coverage: params.anchorCoverage
      ? {
          sufficient: params.anchorCoverage.sufficient,
          missing: params.anchorCoverage.missing,
        }
      : undefined,
  };
}

function tryParseKeyExamples(raw: string): Record<string, string>[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (x) => x && typeof x === "object" && !Array.isArray(x),
      ) as Record<string, string>[];
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function buildSearchTrace(params: {
  specialized: SpecializedSearchPlan;
  stages: StageResult[];
  extractedTokens?: string[];
  discardedSemanticHits?: SearchTrace["discarded_semantic_hits"];
  evidenceItems?: StageEvidenceItem[];
  finalAnswerPreview?: string;
}): SearchTrace {
  const completed: string[] = [];
  const anchor = params.specialized.primary_anchor;

  if (params.stages.some((s) => s.stage === "exact_symbol")) {
    completed.push("extract_technical_symbols");
    completed.push("exact_symbol_search_canonical");
  }
  if (anchor?.anchor_type === "TECHNICAL_SYMBOL") {
    completed.push("set_technical_symbol_primary");
  }

  const mdRun = params.stages.some((s) => s.stage === "master_data");
  if (mdRun) completed.push("find_business_field");
  if (
    params.stages.some(
      (s) =>
        s.stage === "master_data" &&
        s.hits.some((h) => h.id.startsWith("md-values:")),
    )
  ) {
    completed.push("load_values");
    completed.push("load_key_contexts");
  }
  if (
    params.stages.some(
      (s) =>
        s.stage === "classes" ||
        s.stage === "programs" ||
        s.stage === "function_modules" ||
        s.stage === "exact_symbol",
    )
  ) {
    completed.push("find_code_usage");
    completed.push("expand_object_metadata");
  }
  if (params.stages.some((s) => s.stage === "control_tables")) {
    completed.push("find_control_tables");
    completed.push("load_control_values");
  }
  if (params.stages.some((s) => s.stage === "relations")) {
    completed.push("expand_relations");
    completed.push("follow_calls_and_relations");
  }
  if ((params.discardedSemanticHits?.length ?? 0) > 0) {
    completed.push("discard_unrelated_semantic_hits");
  }
  completed.push("synthesize");

  const exactHits = params.stages
    .filter((s) => s.stage === "exact_symbol")
    .flatMap((s) => s.hits)
    .slice(0, 24)
    .map((h) => ({
      title: h.title,
      object_name: h.object_name,
      object_type: h.object_type,
      path_hint: h.path_hint,
    }));

  return {
    template_type: params.specialized.plan_type,
    steps: params.specialized.steps,
    steps_completed: completed,
    primary_anchor: anchor,
    extracted_tokens: params.extractedTokens,
    exact_symbol_hits: exactHits,
    discarded_semantic_hits: params.discardedSemanticHits,
    evidence_passed_to_synthesis: (params.evidenceItems ?? [])
      .slice(0, 30)
      .map((e) => ({
        title: e.title,
        source: e.source,
        evidence_type: e.evidence_type,
      })),
    final_answer_preview: params.finalAnswerPreview,
  };
}

export function structuredContextToPrompt(ctx: StructuredSearchContext): string {
  return JSON.stringify(ctx, null, 2);
}
