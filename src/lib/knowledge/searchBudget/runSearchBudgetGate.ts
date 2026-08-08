/**
 * SEARCH_BUDGET_GATE — decide retrieval/analysis stage before expensive work.
 *
 * Stage 0 LOCAL_EXACT → Stage 1 EXISTING_RETRIEVAL → Stage 2 ON_DEMAND (≤5)
 * → Stage 3 DEEP_ANALYSIS (Vollanalyse / deep_search only).
 *
 * Does not invent answers; does not rebuild indexes; does not run mass analysis.
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";
import type { SearchMode } from "@/lib/knowledge/queryPlanSchema";
import {
  assessLocalExactCoverage,
  prioritizeCommunicationHits,
  type LocalExactCoverage,
} from "./assessLocalExactCoverage";
import {
  extractNamedExternalEntity,
  namedEntityTechnicalAnchors,
} from "./extractNamedExternalEntity";
import {
  DEFAULT_ON_DEMAND_CODE_UNIT_LIMIT,
  emptySearchBudgetDiagnostics,
  type SearchBudgetDiagnostics,
  type SearchBudgetStage,
} from "./types";
import {
  mergePreserveConfirmedSeedEvidence,
} from "@/lib/knowledge/seedEnrichment/confirmedSeedEvidence";

export type SearchBudgetGateDecision = {
  stage: SearchBudgetStage;
  /** Hits to use for synthesis (already prioritized). */
  hits: KnowledgeHit[];
  /** Fail closed: named/technical anchor without local exact evidence. */
  fail_closed: boolean;
  fail_closed_message: string | null;
  /** Allow vector embedding search (Stage 1+). */
  allow_vector_retrieval: boolean;
  /** Allow on-demand code analysis (Stage 2) — capped. */
  allow_on_demand_analysis: boolean;
  on_demand_limit: number;
  coverage: LocalExactCoverage;
  diagnostics: SearchBudgetDiagnostics;
};

function failClosedMessage(entityOrAnchor: string): string {
  return `Zu ${entityOrAnchor} wurden im aktuell verarbeiteten Datenbestand keine belastbare technische Verbindung gefunden.`;
}

/**
 * After Stage-0 (exact/lexical, no vector) hits are known: decide next stage.
 */
export function decideSearchBudgetAfterLocalExact(params: {
  question: string;
  searchMode: SearchMode;
  localHits: KnowledgeHit[];
  onDemandLimit?: number;
  /** When true: literal-index was primary and returned 0 — do not escalate to vector. */
  literalMiss?: boolean;
}): SearchBudgetGateDecision {
  const named = extractNamedExternalEntity(params.question);
  const anchors = namedEntityTechnicalAnchors(params.question);
  const onDemandLimit =
    params.onDemandLimit ?? DEFAULT_ON_DEMAND_CODE_UNIT_LIMIT;

  const coverage = assessLocalExactCoverage({
    hits: params.localHits,
    anchors,
    namedEntity: named?.raw ?? null,
  });

  const prioritized = prioritizeCommunicationHits(
    (() => {
      const base = coverage.local_exact_hits.length
        ? coverage.local_exact_hits
        : params.localHits;
      // Keep confirmed seed-enrichment evidence when LOCAL_EXACT narrows the set.
      return mergePreserveConfirmedSeedEvidence(base, params.localHits);
    })(),
    anchors,
  );

  const diag = emptySearchBudgetDiagnostics("LOCAL_EXACT");
  diag.named_entity = named?.raw ?? null;
  diag.technical_anchors = anchors;
  diag.local_exact_hit_count = coverage.local_exact_hits.length;
  diag.communication_hit_count = coverage.communication_hits.length;
  diag.retrieval_hit_count = params.localHits.length;
  diag.cache_hits = coverage.cache_hits;
  diag.on_demand_limit = onDemandLimit;
  diag.notes.push(coverage.reason);

  // Literal-Index Miss: stay closed — no 284MB embedding load
  if (params.literalMiss) {
    diag.stage_reached = "LOCAL_EXACT";
    diag.blocked_reason =
      "LITERAL_INDEX: kein belegter Treffer — Vector/Embeddings nicht geladen.";
    diag.notes.push(
      "Literal-Suche ohne Treffer; semantische Escalation unterdrückt.",
    );
    return {
      stage: "LOCAL_EXACT",
      hits: [],
      fail_closed: false,
      fail_closed_message: null,
      allow_vector_retrieval: false,
      allow_on_demand_analysis: false,
      on_demand_limit: onDemandLimit,
      coverage: {
        ...coverage,
        sufficient: true,
        reason: "Literal-Index ohne Treffer (kein Vector-Fallback).",
      },
      diagnostics: diag,
    };
  }

  // Stage 3 reserved for Vollanalyse / deep_search
  if (
    params.searchMode === "full_analysis" ||
    params.searchMode === "deep_search"
  ) {
    diag.stage_reached = "DEEP_ANALYSIS";
    diag.escalation_reason =
      params.searchMode === "full_analysis"
        ? "Suchmodus Vollanalyse"
        : "Suchmodus KI-Tiefensuche";
    return {
      stage: "DEEP_ANALYSIS",
      hits: prioritizeCommunicationHits(params.localHits, anchors),
      fail_closed: false,
      fail_closed_message: null,
      allow_vector_retrieval: true,
      allow_on_demand_analysis: true,
      on_demand_limit: onDemandLimit,
      coverage,
      diagnostics: diag,
    };
  }

  // Named / technical anchor with zero exact evidence → fail closed (no semantic substitute)
  if (anchors.length > 0 && coverage.local_exact_hits.length === 0) {
    // Still allow Stage 1 once — semantic may find the same name; fail-closed
    // is applied after Stage 1 if still ungrounded (see finalize).
    diag.stage_reached = "EXISTING_RETRIEVAL";
    diag.escalation_reason =
      "Kein LOCAL_EXACT-Treffer — Hybrid-Index-Suche (ohne neue Analyse).";
    diag.notes.push(
      "Semantische Suche nur ergänzend; ohne Anker-Treffer später fail-closed.",
    );
    return {
      stage: "EXISTING_RETRIEVAL",
      hits: prioritized,
      fail_closed: false,
      fail_closed_message: null,
      allow_vector_retrieval: true,
      allow_on_demand_analysis: false,
      on_demand_limit: onDemandLimit,
      coverage,
      diagnostics: diag,
    };
  }

  if (coverage.sufficient) {
    diag.stage_reached = "LOCAL_EXACT";
    diag.escalation_reason = null;
    diag.blocked_reason =
      "Ausreichende Canonical-/Index-Evidence — keine On-Demand-Methodenanalyse.";
    diag.notes.push(
      "Stage 2/3 gesperrt: bestehende Evidence beantwortet die Frage.",
    );
    return {
      stage: "LOCAL_EXACT",
      hits: prioritized,
      fail_closed: false,
      fail_closed_message: null,
      allow_vector_retrieval: false,
      allow_on_demand_analysis: false,
      on_demand_limit: onDemandLimit,
      coverage,
      diagnostics: diag,
    };
  }

  // Escalate to Stage 1 only
  diag.stage_reached = "EXISTING_RETRIEVAL";
  diag.escalation_reason = coverage.reason;
  return {
    stage: "EXISTING_RETRIEVAL",
    hits: prioritizeCommunicationHits(params.localHits, anchors),
    fail_closed: false,
    fail_closed_message: null,
    allow_vector_retrieval: true,
    allow_on_demand_analysis: false,
    on_demand_limit: onDemandLimit,
    coverage,
    diagnostics: diag,
  };
}

/**
 * After Stage-1 hybrid retrieval: finalize stage, optional Stage-2 cap, fail-closed.
 * Does NOT execute analysis — only decides whether it would be allowed (≤5).
 */
export function finalizeSearchBudgetAfterRetrieval(params: {
  question: string;
  searchMode: SearchMode;
  prior: SearchBudgetGateDecision;
  retrievalHits: KnowledgeHit[];
  relevanceSufficient: boolean;
}): SearchBudgetGateDecision {
  const named = extractNamedExternalEntity(params.question);
  const anchors = namedEntityTechnicalAnchors(params.question);
  const primaryLabel = named?.raw ?? anchors[0] ?? null;

  const coverage = assessLocalExactCoverage({
    hits: params.retrievalHits,
    anchors,
    namedEntity: named?.raw ?? null,
  });

  const prioritized = prioritizeCommunicationHits(
    params.retrievalHits,
    anchors,
  );

  const diag: SearchBudgetDiagnostics = {
    ...params.prior.diagnostics,
    retrieval_hit_count: params.retrievalHits.length,
    local_exact_hit_count: coverage.local_exact_hits.length,
    communication_hit_count: coverage.communication_hits.length,
    cache_hits: coverage.cache_hits,
    on_demand_candidates: coverage.missing_code_analysis.length,
  };

  // Fail closed: named/technical anchor still without exact/grounded hit
  if (
    primaryLabel &&
    anchors.length > 0 &&
    coverage.local_exact_hits.length === 0 &&
    !params.relevanceSufficient
  ) {
    diag.stage_reached = params.prior.stage;
    diag.blocked_reason = "fail_closed_no_technical_link";
    diag.notes.push(failClosedMessage(primaryLabel));
    return {
      ...params.prior,
      stage: params.prior.stage,
      hits: [],
      fail_closed: true,
      fail_closed_message: failClosedMessage(primaryLabel),
      allow_on_demand_analysis: false,
      coverage,
      diagnostics: diag,
    };
  }

  if (
    params.prior.stage === "LOCAL_EXACT" ||
    (coverage.sufficient && params.relevanceSufficient)
  ) {
    diag.stage_reached = "LOCAL_EXACT";
    diag.blocked_reason =
      "Keine On-Demand-Analyse: Canonical/Index-Evidence ausreichend.";
    diag.on_demand_executed = 0;
    return {
      stage: "LOCAL_EXACT",
      hits: prioritized,
      fail_closed: false,
      fail_closed_message: null,
      allow_vector_retrieval: false,
      allow_on_demand_analysis: false,
      on_demand_limit: diag.on_demand_limit,
      coverage,
      diagnostics: diag,
    };
  }

  // Stage 2 only when retrieval insufficient AND concrete code units lack cache
  const needStage2 =
    !params.relevanceSufficient &&
    coverage.missing_code_analysis.length > 0 &&
    params.searchMode !== "full_analysis" &&
    params.searchMode !== "deep_search";

  if (needStage2) {
    diag.stage_reached = "ON_DEMAND_CODE_ANALYSIS";
    diag.escalation_reason =
      "Evidence-Lücke: relevante Codeeinheiten ohne gültige Cache-Analyse.";
    // Gate allows ≤5 — ask path does not auto-run mass analysis here.
    diag.on_demand_executed = 0;
    diag.blocked_reason = `ON_DEMAND_CODE_ANALYSIS erlaubt max. ${diag.on_demand_limit} Einheiten — in diesem Ask-Pfad nicht automatisch gestartet (kein Massenlauf).`;
    diag.notes.push(
      `${Math.min(coverage.missing_code_analysis.length, diag.on_demand_limit)} Kandidaten markiert, 0 ausgeführt.`,
    );
    return {
      stage: "ON_DEMAND_CODE_ANALYSIS",
      hits: prioritized,
      fail_closed: false,
      fail_closed_message: null,
      allow_vector_retrieval: true,
      allow_on_demand_analysis: true,
      on_demand_limit: diag.on_demand_limit,
      coverage,
      diagnostics: diag,
    };
  }

  diag.stage_reached = "EXISTING_RETRIEVAL";
  diag.blocked_reason =
    "Stage 2 nicht nötig oder keine analyselosen Codeeinheiten.";
  return {
    stage: "EXISTING_RETRIEVAL",
    hits: prioritized,
    fail_closed: false,
    fail_closed_message: null,
    allow_vector_retrieval: true,
    allow_on_demand_analysis: false,
    on_demand_limit: diag.on_demand_limit,
    coverage,
    diagnostics: diag,
  };
}

export function estimateEmbeddingTokens(question: string): number {
  return Math.ceil(question.trim().length / 4);
}
