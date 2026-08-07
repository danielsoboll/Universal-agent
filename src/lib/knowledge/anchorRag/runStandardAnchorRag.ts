/**
 * Standard (non-deep) anchor RAG: sweep → expand ≤2 → evidence package → synthesis.
 * No second KI planning round. Optional lightweight heuristic QU.
 */
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";
import { runAnchorRag } from "@/lib/knowledge/anchorRag/runAnchorRag";
import { synthesizeMultiSourceAnswer } from "@/lib/knowledge/multiSourceSearch/synthesize";
import type { QueryUnderstanding } from "@/lib/knowledge/deepSearch/types";
import type { LocalProject } from "@/lib/localAuth/types";
import type { AnchorRagRunResult } from "@/lib/knowledge/anchorRag/runAnchorRag";

export type StandardAnchorRagResult = {
  used: boolean;
  reason: string;
  anchor: AnchorRagRunResult | null;
  direct_answer: string;
  reasoning: string;
  open_questions: string[];
  sources_used: string[];
  model: string;
  token_usage: { input: number; output: number; embedding: number };
  log_dir: string | null;
};

function heuristicQu(question: string): QueryUnderstanding {
  const tokens = extractTechnicalSymbols(question).map((s) => s.norm);
  return {
    original_question: question,
    intent: tokens.length ? "ENTITY_LOOKUP" : "PROCESS_EXPLANATION",
    technical_tokens: tokens,
    business_concepts: [],
    organization_context: [],
    process_context: [],
    user_hypotheses: [],
    assumed_object_types: [],
    requested_output: ["Erklärung"],
    requested_scope: ["Erklärung"],
    preferred_search_plan: tokens.length
      ? "TECHNICAL_SYMBOL_TO_PROCESS"
      : "GENERIC_MULTI_SOURCE",
    search_plan_steps: [],
    irrelevant_question_words: [],
    stopwords_removed: [],
    warnings: ["standard_rag:heuristic_query_understanding"],
    model: "heuristic",
    prompt_version: "standard-anchor-rag-v1",
    confidence: tokens.length ? 0.85 : 0.4,
    token_usage: { input: 0, output: 0 },
  };
}

/**
 * Run when the question contains technical symbols.
 * Returns used=false when no technical tokens (caller keeps hybrid + lexical path).
 *
 * Business questions without symbols are handled by KnowledgeRetriever
 * (hybrid + same lexical DDIC service) — not by seeding Anchor-RAG from
 * lexical hits, which would bypass table/field evidence packages.
 */
export async function runStandardAnchorRag(params: {
  project: LocalProject;
  question: string;
  synthesize?: boolean;
}): Promise<StandardAnchorRagResult> {
  const question = params.question.trim();
  const symbols = extractTechnicalSymbols(question);
  if (symbols.length === 0) {
    return {
      used: false,
      reason: "no_technical_tokens",
      anchor: null,
      direct_answer: "",
      reasoning: "",
      open_questions: [],
      sources_used: [],
      model: "none",
      token_usage: { input: 0, output: 0, embedding: 0 },
      log_dir: null,
    };
  }

  const projectKey =
    params.project.customer_id?.trim() || params.project.id?.trim() || "P01";
  const qu = heuristicQu(question);

  const anchor = await runAnchorRag({
    projectKey,
    question,
    queryUnderstanding: qu,
    enablePlanningRound: false,
    maxHops: 2,
    focused: true,
  });

  let direct_answer = "";
  let reasoning = "";
  let open_questions = [...anchor.evidence_package.open_questions];
  let sources_used: string[] = [];
  let model = "none";
  let tokens = { input: 0, output: 0, embedding: 0 };

  if (params.synthesize !== false) {
    const synth = await synthesizeMultiSourceAnswer({
      question,
      finalContext: anchor.evidence_prompt_block,
      contextCharLimit: 8_000,
      structuredContext: {
        question,
        plan_type: "TECHNICAL_SYMBOL_TO_PROCESS",
        primary_anchor: {
          anchor_type: "TECHNICAL_SYMBOL",
          table: symbols[0]!.norm,
          symbol: symbols[0]!.norm,
          objects: anchor.graph.primary_anchors,
          confidence: 0.95,
        },
        field_values: [],
        key_contexts: [],
        control_tables: [],
        control_values: [],
        class_evidence: [],
        program_evidence: [],
        function_module_evidence: [],
        relations: [],
        coverage: {},
        open_questions,
      },
    });
    direct_answer = synth.answer.direct_answer;
    reasoning = synth.answer.reasoning;
    open_questions = [
      ...new Set([...open_questions, ...synth.answer.open_questions]),
    ];
    sources_used = synth.answer.sources_used;
    model = synth.model;
    tokens = {
      input: synth.tokens.input,
      output: synth.tokens.output,
      embedding: 0,
    };
  } else {
    // Deterministic short summary from proven claims
    direct_answer = [
      `Primäranker: ${anchor.graph.primary_anchors.join(", ")}`,
      ...anchor.evidence_package.proven_claims.slice(0, 12),
    ].join("\n");
    reasoning = "Deterministische Evidence-Package-Zusammenfassung (ohne LLM).";
    sources_used = anchor.evidence_package.proven_claims.slice(0, 8);
  }

  return {
    used: true,
    reason: "technical_anchor_rag",
    anchor,
    direct_answer,
    reasoning,
    open_questions,
    sources_used,
    model,
    token_usage: tokens,
    log_dir: `logs/search-runs/${anchor.run_id}`,
  };
}
