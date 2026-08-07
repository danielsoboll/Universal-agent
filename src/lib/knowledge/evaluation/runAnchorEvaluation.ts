/**
 * Anchor evaluation orchestration (generic).
 * Writes artifacts under logs/evaluation/{anchorSlug}/.
 */
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";
import { ensureWritableDir, writeGeneratedText } from "@/lib/localData/fs";
import { runAnchorRag } from "@/lib/knowledge/anchorRag/runAnchorRag";
import { synthesizeMultiSourceAnswer } from "@/lib/knowledge/multiSourceSearch/synthesize";
import type { QueryUnderstanding } from "@/lib/knowledge/deepSearch/types";
import { buildGroundTruthInventory } from "./groundTruthInventory";
import {
  buildEvaluationReport,
  type EvaluationReport,
} from "./compareEvaluation";

function slugify(anchor: string): string {
  return anchor.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

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
    warnings: ["evaluation:heuristic_query_understanding"],
    model: "heuristic",
    prompt_version: "anchor-eval-v1",
    confidence: tokens.length ? 0.85 : 0.4,
    token_usage: { input: 0, output: 0 },
  };
}

function writeJson(
  projectKey: string,
  rel: string,
  data: unknown,
): string {
  return writeGeneratedText(
    projectKey,
    "logs",
    rel,
    `${JSON.stringify(data, null, 2)}\n`,
  );
}

export type AnchorEvaluationResult = {
  dir: string;
  ground_truth_path: string;
  retrieval_path: string;
  openai_input_path: string;
  openai_output_path: string;
  report_path: string;
  report: EvaluationReport;
  direct_answer: string;
};

/**
 * Full evaluation for one technical-symbol question.
 */
export async function runAnchorEvaluation(params: {
  projectKey: string;
  anchor: string;
  question: string;
  iteration?: number;
  synthesize?: boolean;
  focused?: boolean;
}): Promise<AnchorEvaluationResult> {
  const projectKey = params.projectKey;
  const anchor = params.anchor.trim().toUpperCase();
  const slug = slugify(anchor);
  const iter = params.iteration ?? 0;
  const base = `evaluation/${slug}`;
  ensureWritableDir(projectKey, "logs", base);
  if (iter > 0) ensureWritableDir(projectKey, "logs", `${base}/iterations`);

  const started = Date.now();

  // --- Step 1: Ground truth ---
  const groundTruth = await buildGroundTruthInventory({
    projectKey,
    anchor,
  });
  const ground_truth_path = writeJson(
    projectKey,
    `${base}/ground-truth.json`,
    groundTruth,
  );

  // --- Step 2: Retrieval ---
  const qu = heuristicQu(params.question);
  const focused = params.focused !== false;
  const rag = await runAnchorRag({
    projectKey,
    question: params.question,
    queryUnderstanding: qu,
    enablePlanningRound: false,
    maxHops: 2,
    focused,
  });

  const retrievedEntityKeys = [
    ...new Set([
      ...rag.inventories.flatMap((inv) =>
        inv.hits.map((h) => `${h.type}:${h.object_id || h.name}`),
      ),
      ...rag.graph.nodes.map((n) => `${n.type}:${n.name}`),
    ]),
  ];

  const allInventoryHits = rag.inventories.flatMap((i) => i.hits);
  const evidenceNodeKeys = rag.evidence_package.code_units
    .map((u) => {
      const type = String((u as { type?: string }).type ?? "CODE");
      const name = String(
        (u as { name?: string }).name ??
          (u as { id?: string }).id ??
          "",
      );
      return `${type}:${name}`;
    })
    .filter((k) => !k.endsWith(":"));

  const configKeys: string[] = [];
  const idoc = rag.evidence_package.idoc_configuration as {
    output_types?: Array<{ type?: string; name?: string; id?: string }>;
    texts?: Array<{ type?: string; name?: string; id?: string }>;
    processing?: Array<{ type?: string; name?: string; id?: string }>;
  };
  for (const n of idoc.output_types ?? []) {
    configKeys.push(`OUTPUT_TYPE:${n.name ?? n.id ?? ""}`);
  }
  for (const n of idoc.texts ?? []) {
    configKeys.push(`OUTPUT_TYPE_TEXT:${n.name ?? n.id ?? ""}`);
  }
  for (const n of idoc.processing ?? []) {
    configKeys.push(`OUTPUT_PROCESSING:${n.name ?? n.id ?? ""}`);
  }

  const evidenceEntityKeys = [
    ...new Set([
      ...evidenceNodeKeys,
      ...configKeys,
      ...rag.graph.nodes
        .filter((n) =>
          rag.evidence_package.proven_claims.some(
            (c) =>
              c.toUpperCase().includes(n.name.toUpperCase()) ||
              c.toUpperCase().includes(n.id.toUpperCase()),
          ) ||
          rag.evidence_package.code_units.some(
            (u) =>
              String((u as { name?: string }).name ?? "")
                .toUpperCase()
                .includes(n.name.toUpperCase()) ||
              String((u as { id?: string }).id ?? "") === n.id,
          ) ||
          n.type === "OUTPUT_TYPE" ||
          n.type === "OUTPUT_TYPE_TEXT" ||
          n.type === "OUTPUT_PROCESSING" ||
          n.type === "PROGRAM" ||
          n.type === "FORM_ROUTINE" ||
          n.type === "FUNCTION_MODULE",
        )
        .flatMap((n) => [
          `${n.type}:${n.name}`,
          `${n.type}:${n.id.replace(/^node:[^:]+:/, "")}`,
        ]),
      ...rag.graph.primary_anchors.map((a) => `TECHNICAL_SYMBOL:${a}`),
    ]),
  ];

  const evidenceRelationKeys = (rag.evidence_package.call_chains ?? []).map(
    (e) => {
      const from = String((e as { from?: string }).from ?? "");
      const rel = String((e as { relation?: string }).relation ?? "");
      const to = String((e as { to?: string }).to ?? "");
      return `${from}|${rel}|${to}`;
    },
  );

  const discarded = allInventoryHits
    .map((h) => `${h.type}:${h.object_id || h.name}`)
    .filter((k) => !evidenceEntityKeys.some((e) => e.toUpperCase() === k.toUpperCase()));

  const retrievalPayload = {
    question: params.question,
    query_understanding: qu,
    technical_tokens: qu.technical_tokens,
    focused,
    primary_anchors: rag.graph.primary_anchors,
    exact_hits: allInventoryHits.filter((h) => h.exact_match),
    semantic_hits: [], // standard anchor path has no semantic stage
    inventories: rag.inventories,
    discarded_hits: discarded.slice(0, 200),
    relation_expansion: {
      node_count: rag.graph.nodes.length,
      edge_count: rag.graph.edges.length,
      metrics: rag.metrics,
    },
    selected_evidence_summary: {
      proven_claims: rag.evidence_package.proven_claims,
      open_questions: rag.evidence_package.open_questions,
      code_units: rag.evidence_package.code_units.length,
      call_chains: rag.evidence_package.call_chains.length,
    },
    duration_ms: Date.now() - started,
  };

  const retrieval_path = writeJson(
    projectKey,
    `${base}/retrieval-run.json`,
    retrievalPayload,
  );

  // --- Step 3+4: OpenAI input/output ---
  const evidenceText = rag.evidence_prompt_block;
  let openaiInput: unknown = null;
  let openaiOutput: unknown = null;
  let direct_answer = "";
  let reasoning = "";
  let open_questions = [...rag.evidence_package.open_questions];
  let sources_used: string[] = [];
  let tokens = { input: 0, output: 0 };
  let truncated = false;

  if (params.synthesize !== false) {
    const synth = await synthesizeMultiSourceAnswer({
      question: params.question,
      finalContext: evidenceText,
      contextCharLimit: 8_000,
      structuredContext: {
        question: params.question,
        plan_type: "TECHNICAL_SYMBOL_TO_PROCESS",
        primary_anchor: {
          anchor_type: "TECHNICAL_SYMBOL",
          table: anchor,
          symbol: anchor,
          objects: rag.graph.primary_anchors,
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
    openaiInput = {
      ...synth.openai_input,
      entity_count: evidenceEntityKeys.length,
      relation_count: evidenceRelationKeys.length,
      token_usage_estimate_chars: synth.openai_input.context_chars_after_slice,
      ranking: rag.evidence_package.proven_claims.slice(0, 20),
      source_coverage: rag.evidence_package.source_coverage,
    };
    truncated = synth.openai_input.truncated;
    openaiOutput = {
      raw: synth.raw_content,
      structured: synth.answer,
      claims_used: synth.answer.sources_used,
      referenced_sources: synth.answer.sources_used,
      open_points: synth.answer.open_questions,
      token_usage: synth.tokens,
      model: synth.model,
    };
    direct_answer = synth.answer.direct_answer;
    reasoning = synth.answer.reasoning;
    open_questions = [
      ...new Set([...open_questions, ...synth.answer.open_questions]),
    ];
    sources_used = synth.answer.sources_used;
    tokens = synth.tokens;
  } else {
    direct_answer = rag.evidence_package.proven_claims.slice(0, 12).join("\n");
    openaiInput = {
      skipped: true,
      evidence_prompt_block: evidenceText,
    };
    openaiOutput = { skipped: true };
  }

  const openai_input_path = writeJson(
    projectKey,
    `${base}/openai-input.json`,
    openaiInput,
  );
  const openai_output_path = writeJson(
    projectKey,
    `${base}/openai-output.json`,
    openaiOutput,
  );

  // --- Step 5: Compare ---
  const report = buildEvaluationReport({
    groundTruth,
    question: params.question,
    retrievedEntityKeys,
    evidenceEntityKeys,
    evidenceRelationKeys,
    evidenceText,
    answerText: `${direct_answer}\n${reasoning}`,
    discardedEntityKeys: discarded,
    truncated,
    metrics: {
      duration_ms: Date.now() - started,
      sweep_ms: rag.metrics.sweep_ms,
      expansion_ms: rag.metrics.expansion_ms,
      documents_scanned: rag.metrics.documents_scanned,
      inventory_hits: rag.metrics.inventory_hits,
      graph_nodes: rag.graph.nodes.length,
      graph_edges: rag.graph.edges.length,
      openai_input_tokens: tokens.input,
      openai_output_tokens: tokens.output,
      iteration: iter,
      focused,
    },
  });

  const report_path = writeJson(
    projectKey,
    `${base}/evaluation-report.json`,
    report,
  );

  if (iter > 0) {
    writeJson(
      projectKey,
      `${base}/iterations/iter-${iter}-report.json`,
      report,
    );
  }

  // Convenience copy of answer
  writeJson(projectKey, `${base}/final-answer.json`, {
    direct_answer,
    reasoning,
    open_questions,
    sources_used,
    token_usage: tokens,
  });

  return {
    dir: `logs/${base}`,
    ground_truth_path,
    retrieval_path,
    openai_input_path,
    openai_output_path,
    report_path,
    report,
    direct_answer,
  };
}
