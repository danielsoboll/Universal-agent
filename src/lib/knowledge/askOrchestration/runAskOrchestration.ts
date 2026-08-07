/**
 * Generic ask orchestration — intent → graph-first / inventory → budget → claims.
 * No question hardcoding, no demo fixtures, no mass analysis.
 */
import { BOUND_DATA_PROJECT_KEY } from "@/lib/localData/boundProject";
import { runInventoryAggregationResolver } from "@/lib/knowledge/inventoryAggregation";
import { runEntityListAggregationResolver } from "@/lib/knowledge/entityListAggregation";
import { runHardcodedValueInventoryResolver } from "@/lib/knowledge/hardcodedValueInventory";
import {
  classifyAskIntent,
  type AskIntentClassification,
  type AskOrchestrationIntent,
} from "./classifyAskIntent";
import {
  assessEvidenceCoverage,
  evidenceBudgetFor,
  type EvidenceCoverageReport,
} from "./evidenceBudget";
import { verifyClaims, type VerifiedClaim } from "./claimVerifier";
import {
  runGraphFirstRetrieval,
  type GraphFirstRetrieval,
} from "./graphFirstRetrieval";
import { formatOrchestratedAnswer } from "./formatOrchestratedAnswer";
import { applyOrchestrationRelevanceGate } from "./orchestrationRelevanceGate";
import { collectRelatedMethodSymbols } from "./collectMethodSymbols";
import { buildProcessAnswerView } from "./buildProcessAnswerView";
import type { ProcessAnswerView } from "./relevanceGateTypes";
import { buildStructuredAnswerFromOrchestration } from "@/lib/knowledge/structuredAnswer";
import type { StructuredAnswer } from "@/lib/knowledge/structuredAnswer";

export type AskOrchestrationDiagnostics = {
  intent: AskOrchestrationIntent;
  classification: AskIntentClassification;
  seeds: string[];
  graph_paths: GraphFirstRetrieval["graph_paths"];
  canonical_sources: string[];
  cached_method_analyses: Array<{
    source_key: string;
    object_name: string;
    unit_name: string;
    cache_hit: boolean;
  }>;
  evidence_coverage: EvidenceCoverageReport;
  discarded_unsupported_claims: Array<{ text: string; reason: string }>;
  relation_hops: GraphFirstRetrieval["relation_hops"];
  duration_ms: number;
  /** Present when inventory path ran. */
  inventory: import("@/lib/knowledge/inventoryAggregation").InventoryDiagnostics | null;
  /** Present when entity-list path ran. */
  entity_list: import("@/lib/knowledge/entityListAggregation").EntityListDiagnostics | null;
  /** Present when hardcoded-value inventory path ran. */
  hardcoded_value: import("@/lib/knowledge/hardcodedValueInventory").HardcodedValueDiagnostics | null;
  /** Relevance gate stats when process/trace path ran. */
  relevance_gate?: {
    candidates_before: number;
    candidates_after: number;
    excluded_shared_token_only: string[];
    accepted_paths: string[];
    query_terms: string[];
    strong_seeds: string[];
  } | null;
};

export type AskOrchestrationResult = {
  used: boolean;
  /** When false, caller may fall through to hybrid Top-k. */
  handoff_to_hybrid: boolean;
  intent: AskOrchestrationIntent;
  answer_markdown: string;
  summary: string;
  status: "ok" | "insufficient";
  diagnostics: AskOrchestrationDiagnostics;
  claims: VerifiedClaim[];
  /** Structured inventory UI payload when inventory path ran. */
  inventory_answer?: import("@/lib/knowledge/inventoryAggregation").InventoryAnswerView | null;
  /** Structured entity-list UI payload when ENTITY_LIST path ran. */
  entity_list_answer?: import("@/lib/knowledge/entityListAggregation").EntityListAnswerView | null;
  /** Structured hardcoded-value inventory UI payload. */
  hardcoded_value_answer?: import("@/lib/knowledge/hardcodedValueInventory").HardcodedValueAnswerView | null;
  /** Structured process UI payload when PROCESS/TRACE ran. */
  process_answer_view?: import("./relevanceGateTypes").ProcessAnswerView | null;
  /** Unified product answer object (always set when used). */
  structured_answer?: import("@/lib/knowledge/structuredAnswer").StructuredAnswer | null;
};

export async function runAskOrchestration(params: {
  question: string;
  projectKey?: string;
}): Promise<AskOrchestrationResult> {
  const result = await runAskOrchestrationInner(params);
  return finalizeOrchestration(result);
}

function finalizeOrchestration(
  result: AskOrchestrationResult,
): AskOrchestrationResult {
  if (!result.used || result.handoff_to_hybrid) {
    return { ...result, structured_answer: null };
  }
  const structured_answer = buildStructuredAnswerFromOrchestration(result);
  return {
    ...result,
    structured_answer,
    answer_markdown: structured_answer.summary,
    summary: structured_answer.summary,
  };
}

async function runAskOrchestrationInner(params: {
  question: string;
  projectKey?: string;
}): Promise<AskOrchestrationResult> {
  const started = Date.now();
  const projectKey = params.projectKey?.trim() || BOUND_DATA_PROJECT_KEY;
  const classification = classifyAskIntent(params.question);
  const budget = evidenceBudgetFor(classification.intent);

  // --- Inventory path (canonical enumeration, never Top-k) ---
  if (classification.intent === "INVENTORY_AND_AGGREGATION") {
    const inv = await runInventoryAggregationResolver({
      question: params.question,
      projectKey,
    });
    const coverage = assessEvidenceCoverage({
      budget,
      authoritative_objects: inv.aggregation.total_output_types > 0 ? 1 : 0,
      technical_anchors: inv.application ? 1 : 0,
      process_steps: 0,
      code_units: 0,
      has_enumeration: inv.used && inv.aggregation.total_output_types > 0,
      has_trace_path: false,
    });
    const { kept, discarded } = verifyClaims([
      {
        text: inv.summary_sentence,
        from_deterministic_enumeration: true,
        has_authoritative_object_evidence: true,
      },
      {
        text: `EDI Medium 6: ${inv.aggregation.edi_medium_output_types}`,
        from_deterministic_enumeration: true,
        has_authoritative_object_evidence: true,
      },
    ]);
    const answer = formatOrchestratedAnswer({
      intent: classification.intent,
      question: params.question,
      coverage,
      claims: kept,
      graph: null,
      inventory_markdown: inv.summary_sentence,
    });
    return {
      used: inv.used,
      handoff_to_hybrid: false,
      intent: classification.intent,
      answer_markdown: inv.summary_sentence,
      summary: inv.summary_sentence,
      inventory_answer: inv.answer_view,
      status: coverage.sufficient ? "ok" : "insufficient",
      claims: kept,
      diagnostics: {
        intent: classification.intent,
        classification,
        seeds: classification.technical_symbols,
        graph_paths: [],
        canonical_sources: inv.sources,
        cached_method_analyses: [],
        evidence_coverage: coverage,
        discarded_unsupported_claims: discarded.map((d) => ({
          text: d.text,
          reason: d.reason,
        })),
        relation_hops: null,
        duration_ms: Date.now() - started,
        inventory: inv.diagnostics,
        entity_list: null,
        hardcoded_value: null,
        relevance_gate: null,
      },
    };
  }

  // --- Hardcoded value inventory (deterministic MATNR/literal scan) ---
  if (classification.intent === "HARDCODED_VALUE_INVENTORY") {
    const hc = await runHardcodedValueInventoryResolver({
      question: params.question,
      projectKey,
    });
    const unique = hc.answer_view?.summary.unique_material_count ?? 0;
    const units = hc.diagnostics.units_scanned;
    const coverage = assessEvidenceCoverage({
      budget,
      authoritative_objects: unique > 0 ? 1 : 0,
      technical_anchors: 0,
      process_steps: 0,
      code_units: units,
      has_enumeration: hc.used,
      has_trace_path: false,
    });
    const { kept, discarded } = verifyClaims([
      {
        text: hc.summary_sentence,
        from_deterministic_enumeration: true,
        has_authoritative_object_evidence: unique > 0 || units > 0,
        has_code_evidence: units > 0,
      },
      ...(hc.answer_view?.materials.slice(0, 40).map((m) => ({
        text: `Hart codierte Materialnummer ${m.material_number}${
          m.process_label ? ` — Prozess: ${m.process_label}` : ""
        } (Fundstellen: ${m.occurrence_count})`,
        from_deterministic_enumeration: true,
        has_authoritative_object_evidence: true,
        has_code_evidence: true,
      })) ?? []),
    ]);
    return {
      used: hc.used,
      handoff_to_hybrid: false,
      intent: classification.intent,
      answer_markdown: hc.summary_sentence,
      summary: hc.summary_sentence,
      inventory_answer: null,
      entity_list_answer: null,
      hardcoded_value_answer: hc.answer_view,
      status: coverage.sufficient ? "ok" : "insufficient",
      claims: kept,
      diagnostics: {
        intent: classification.intent,
        classification,
        seeds: classification.lexical_seeds,
        graph_paths: [],
        canonical_sources: hc.sources,
        cached_method_analyses: [],
        evidence_coverage: coverage,
        discarded_unsupported_claims: discarded.map((d) => ({
          text: d.text,
          reason: d.reason,
        })),
        relation_hops: null,
        duration_ms: Date.now() - started,
        inventory: null,
        entity_list: null,
        hardcoded_value: hc.diagnostics,
        relevance_gate: null,
      },
    };
  }

  // --- Entity list path (rollup method hits → parent entities, card UI) ---
  if (classification.intent === "ENTITY_LIST") {
    const el = await runEntityListAggregationResolver({
      question: params.question,
      projectKey,
    });
    const primary = el.answer_view?.summary.primary_count ?? 0;
    const supporting = el.answer_view?.summary.supporting_count ?? 0;
    const unique = el.answer_view?.summary.unique_entity_count ?? 0;
    const coverage = assessEvidenceCoverage({
      budget,
      authoritative_objects: primary > 0 ? 1 : 0,
      technical_anchors: unique > 0 ? 1 : 0,
      process_steps: 0,
      code_units: el.diagnostics.raw_hit_count,
      has_enumeration: unique > 0,
      has_trace_path: false,
    });
    const { kept, discarded } = verifyClaims([
      {
        text: el.summary_sentence,
        from_deterministic_enumeration: true,
        has_authoritative_object_evidence: primary + supporting > 0,
        has_code_evidence: el.diagnostics.raw_hit_count > 0,
      },
    ]);
    return {
      used: el.used,
      handoff_to_hybrid: false,
      intent: classification.intent,
      answer_markdown: el.summary_sentence,
      summary: el.summary_sentence,
      inventory_answer: null,
      entity_list_answer: el.answer_view,
      status: coverage.sufficient ? "ok" : "insufficient",
      claims: kept,
      diagnostics: {
        intent: classification.intent,
        classification,
        seeds: classification.lexical_seeds,
        graph_paths: [],
        canonical_sources: el.sources,
        cached_method_analyses: [],
        evidence_coverage: coverage,
        discarded_unsupported_claims: discarded.map((d) => ({
          text: d.text,
          reason: d.reason,
        })),
        relation_hops: null,
        duration_ms: Date.now() - started,
        inventory: null,
        entity_list: el.diagnostics,
        hardcoded_value: null,
      },
    };
  }

  // --- UNKNOWN with no seeds: allow hybrid handoff ---
  if (
    classification.intent === "UNKNOWN" &&
    classification.technical_symbols.length === 0 &&
    classification.lexical_seeds.length === 0
  ) {
    return {
      used: false,
      handoff_to_hybrid: true,
      intent: classification.intent,
      answer_markdown: "",
      summary: "",
      status: "insufficient",
      claims: [],
      diagnostics: {
        intent: classification.intent,
        classification,
        seeds: [],
        graph_paths: [],
        canonical_sources: [],
        cached_method_analyses: [],
        evidence_coverage: assessEvidenceCoverage({
          budget,
          authoritative_objects: 0,
          technical_anchors: 0,
          process_steps: 0,
          code_units: 0,
          has_enumeration: false,
          has_trace_path: false,
        }),
        discarded_unsupported_claims: [],
        relation_hops: null,
        duration_ms: Date.now() - started,
        inventory: null,
        entity_list: null,
        hardcoded_value: null,
        relevance_gate: null,
      },
    };
  }

  // --- Graph-first for process / trace / lookup / comparison ---
  const graphRaw = await runGraphFirstRetrieval({
    question: params.question,
    intent: classification,
    budget,
    projectKey,
  });

  const useRelevanceGate =
    classification.intent === "PROCESS_EXPLANATION" ||
    classification.intent === "TECHNICAL_TRACE" ||
    classification.intent === "COMPARISON" ||
    classification.intent === "OBJECT_LOOKUP";

  let process_answer_view: ProcessAnswerView | null = null;
  let relevanceDiag: AskOrchestrationDiagnostics["relevance_gate"] = null;

  let graph = graphRaw;
  if (useRelevanceGate) {
    const method_symbol_names = await collectRelatedMethodSymbols({
      projectKey,
      query_terms: classification.lexical_seeds,
    });
    const gate = applyOrchestrationRelevanceGate({
      intent: classification.intent,
      query_terms: classification.lexical_seeds,
      technical_symbols: classification.technical_symbols,
      graph: graphRaw,
      method_symbol_names,
    });
    graph = {
      ...graphRaw,
      // Query terms stay in retrieval seeds diagnostics, but synthesis uses gated set
      graph_paths: gate.filtered_graph_paths,
      cached_analyses: gate.filtered_analyses,
      authoritative_nodes: [
        ...gate.filtered_authoritative_nodes,
        ...gate.field_refs.map((f) => `FIELD:${f.object_name}`),
      ],
    };
    process_answer_view = buildProcessAnswerView({
      question: params.question,
      gate,
    });
    relevanceDiag = {
      candidates_before: gate.candidates_before.length,
      candidates_after: gate.accepted.length,
      excluded_shared_token_only: gate.excluded_shared_token_only,
      accepted_paths: gate.accepted_paths,
      query_terms: gate.query_terms,
      strong_seeds: gate.strong_seeds,
    };
  }

  const process_steps = Math.max(
    graph.cached_analyses.filter((a) => a.summary).length,
    process_answer_view?.process_steps.length ?? 0,
    graph.graph_paths.filter((p) => p.distance <= 1).length >= 2
      ? Math.min(graph.graph_paths.filter((p) => p.distance <= 1).length, 8)
      : graph.graph_paths.filter((p) => p.path_relations.length > 0).length,
  );
  const has_trace_path = graph.graph_paths.some(
    (p) => p.distance >= 0 && (p.path_relations.length > 0 || p.distance === 0),
  );
  const code_units = graph.graph_paths.length;
  const technical_anchors =
    (relevanceDiag?.strong_seeds.length ?? 0) ||
    (graph.authoritative_nodes.length > 0 || graph.graph_paths.length > 0
      ? 1
      : 0);

  // OBJECT_LOOKUP: symbol + code/graph hit is enough; authoritative preferred
  // but not mandatory when a clear technical match exists.
  let authoritative_objects = graph.authoritative_nodes.filter(
    (n) => !n.startsWith("FIELD:"),
  ).length;
  if (
    classification.intent === "OBJECT_LOOKUP" &&
    authoritative_objects === 0 &&
    technical_anchors >= 1 &&
    code_units >= 1
  ) {
    authoritative_objects = 1;
  }
  if (useRelevanceGate && (relevanceDiag?.strong_seeds.length ?? 0) > 0) {
    authoritative_objects = Math.max(authoritative_objects, 1);
  }

  const coverage = assessEvidenceCoverage({
    budget,
    authoritative_objects,
    technical_anchors,
    process_steps,
    code_units,
    has_enumeration: false,
    has_trace_path,
  });

  const draftClaims: Array<{
    text: string;
    has_authoritative_object_evidence?: boolean;
    has_code_evidence?: boolean;
    has_graph_edge?: boolean;
  }> = [];

  if (process_answer_view) {
    draftClaims.push({
      text: process_answer_view.summary,
      has_code_evidence: process_answer_view.technical_findings.length > 0,
      has_authoritative_object_evidence:
        process_answer_view.technical_anchors.length > 0,
    });
    for (const step of process_answer_view.process_steps.slice(0, 6)) {
      draftClaims.push({
        text: step.text,
        has_code_evidence: true,
        has_graph_edge: true,
      });
    }
    for (const f of process_answer_view.tables_fields_config.slice(0, 6)) {
      draftClaims.push({
        text: `${f.object_type}:${f.object_name}`,
        has_authoritative_object_evidence: true,
        has_code_evidence: f.role === "field",
      });
    }
  } else {
    // Prefer code/cache claims tied to selected units first (more question-relevant)
    for (const a of graph.cached_analyses.slice(0, 8)) {
      if (!a.summary) continue;
      draftClaims.push({
        text: `${a.object_name}.${a.unit_name}: ${a.summary}`,
        has_code_evidence: true,
        has_graph_edge: true,
      });
    }
    for (const p of graph.graph_paths.slice(0, 8)) {
      if (!p.path_relations.length && p.distance > 0) continue;
      draftClaims.push({
        text: p.path_relations.length
          ? `Graphpfad ${p.object_name}.${p.unit_name}: ${p.path_relations.join(" → ")}`
          : `Codeanker ${p.object_name}.${p.unit_name} (Direkttreffer, Distanz ${p.distance})`,
        has_graph_edge: true,
        has_code_evidence: true,
      });
    }
    const focusHay = [
      ...graph.graph_paths.map((p) => p.object_name.toUpperCase()),
      ...classification.technical_symbols,
    ];
    for (const n of graph.authoritative_nodes.slice(0, 20)) {
      const nu = n.toUpperCase();
      if (!focusHay.some((h) => h.length >= 4 && nu.includes(h))) continue;
      draftClaims.push({
        text: `${n} ist im Knowledge Graph mit autoritativer Existenz belegt.`,
        has_authoritative_object_evidence: true,
        has_graph_edge: true,
      });
    }
  }

  const { kept, discarded } = verifyClaims(draftClaims);

  // If graph-first found nothing useful for lookup/process, hand off to hybrid
  // as supplement — but only when budget allows top-k OR coverage empty.
  const emptyGraph =
    graph.graph_paths.length === 0 &&
    graph.cached_analyses.length === 0 &&
    graph.authoritative_nodes.length === 0;

  if (emptyGraph && budget.allow_top_k_primary) {
    return {
      used: false,
      handoff_to_hybrid: true,
      intent: classification.intent,
      answer_markdown: "",
      summary: "",
      status: "insufficient",
      claims: [],
      process_answer_view: null,
      diagnostics: {
        intent: classification.intent,
        classification,
        seeds: graphRaw.seeds,
        graph_paths: [],
        canonical_sources: graph.canonical_sources,
        cached_method_analyses: [],
        evidence_coverage: coverage,
        discarded_unsupported_claims: discarded.map((d) => ({
          text: d.text,
          reason: d.reason,
        })),
        relation_hops: graph.relation_hops,
        duration_ms: Date.now() - started,
        inventory: null,
        entity_list: null,
        hardcoded_value: null,
        relevance_gate: relevanceDiag,
      },
    };
  }

  // Process/trace/lookup: answer from graph even if insufficient (honest gaps)
  const answer = formatOrchestratedAnswer({
    intent: classification.intent,
    question: params.question,
    coverage,
    claims: kept,
    graph,
    process_answer_view,
  });

  const summary =
    process_answer_view?.summary ??
    kept[0]?.text ??
    (coverage.sufficient
      ? "Evidenz aus Graph und Cache zusammengestellt."
      : `Unvollständige Evidenz — fehlt: ${coverage.missing.join("; ")}`);

  return {
    used: true,
    handoff_to_hybrid: false,
    intent: classification.intent,
    answer_markdown: process_answer_view?.summary ?? answer,
    summary,
    process_answer_view,
    status: coverage.sufficient ? "ok" : "insufficient",
    claims: kept,
    diagnostics: {
      intent: classification.intent,
      classification,
      seeds: relevanceDiag?.strong_seeds ?? graphRaw.seeds,
      graph_paths: graph.graph_paths,
      canonical_sources: graph.canonical_sources,
      cached_method_analyses: graph.cached_analyses.map((a) => ({
        source_key: a.source_key,
        object_name: a.object_name,
        unit_name: a.unit_name,
        cache_hit: a.cache_hit,
      })),
      evidence_coverage: coverage,
      discarded_unsupported_claims: discarded.map((d) => ({
        text: d.text,
        reason: d.reason,
      })),
      relation_hops: graph.relation_hops,
      duration_ms: Date.now() - started,
      inventory: null,
      entity_list: null,
      hardcoded_value: null,
      relevance_gate: relevanceDiag,
    },
  };
}
