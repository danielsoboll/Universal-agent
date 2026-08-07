/**
 * Multi-source / staged RAG orchestrator.
 * Separate pipeline — does not modify direct_rag or rebuild hybrid indexes.
 */
import { randomUUID } from "crypto";
import type { LocalProject } from "@/lib/localAuth/types";
import { resolveAskLocalProject } from "@/lib/knowledge/resolveAskProject";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { AnchorSet, makeAnchor } from "@/lib/knowledge/multiSourceSearch/anchors";
import {
  coverageBySource,
  diagnoseSourceCoverage,
} from "@/lib/knowledge/multiSourceSearch/coverage";
import {
  bundleEvidence,
  buildFinalContext,
} from "@/lib/knowledge/multiSourceSearch/evidence";
import { buildMultiSourceSearchPlan } from "@/lib/knowledge/multiSourceSearch/plan";
import { persistMultiSourceRun } from "@/lib/knowledge/multiSourceSearch/persist";
import {
  detectControlTableAnchor,
  detectPrimaryAnchorFromMasterHits,
  detectTechnicalSymbolPrimary,
  hasStrongExactSymbolCodeHit,
  isGenericMessageNoise,
  primaryAnchorNeedles,
} from "@/lib/knowledge/multiSourceSearch/primaryAnchor";
import { runClassesStage } from "@/lib/knowledge/multiSourceSearch/stages/classes";
import { runControlTablesStage } from "@/lib/knowledge/multiSourceSearch/stages/controlTables";
import { runExactSymbolStage } from "@/lib/knowledge/multiSourceSearch/stages/exactSymbol";
import { runRelationsExpansionStage } from "@/lib/knowledge/multiSourceSearch/stages/expansion";
import { runMasterDataStage } from "@/lib/knowledge/multiSourceSearch/stages/masterData";
import {
  runFunctionModulesStage,
  runProgramsStage,
} from "@/lib/knowledge/multiSourceSearch/stages/programsFm";
import {
  buildSpecializedPlan,
  evaluatePrimaryAnchorCoverage,
  stageOrderForRun,
} from "@/lib/knowledge/multiSourceSearch/specializedPlan";
import { synthesizeMultiSourceAnswer } from "@/lib/knowledge/multiSourceSearch/synthesize";
import { filterRetrievalConcepts } from "@/lib/knowledge/queryStopwords";
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";
import {
  buildSearchTrace,
  buildStructuredContext,
} from "@/lib/knowledge/multiSourceSearch/structuredContext";
import type {
  MultiSourceId,
  MultiSourceRunResult,
  PrimaryAnchor,
  SpecializedSearchPlan,
  StageEvidenceItem,
  StageResult,
} from "@/lib/knowledge/multiSourceSearch/types";

export type RunMultiSourceSearchParams = {
  projectId: string;
  question: string;
  project?: LocalProject;
  maxRounds?: number;
  enrichPlanWithLlm?: boolean;
  synthesize?: boolean;
  /** Optional note comparing to direct_rag (caller may attach). */
  compareNote?: string;
  /** Deep-search seeds from Query Understanding (optional). */
  planSeeds?: {
    concepts?: string[];
    synonyms?: string[];
    notes?: string[];
    /** Soft org context — logged, not forced as hard anchors. */
    soft_context?: string[];
    hypotheses_to_verify?: string[];
  };
};

function emptySpecializedPlan(): SpecializedSearchPlan {
  return {
    plan_type: "GENERIC",
    primary_anchor: null,
    steps: ["broad_concept_search", "expand_anchors", "synthesize"],
    abort_broad_search: false,
    notes: [],
  };
}

function seedAnchorsFromPlan(
  concepts: string[],
  synonyms: string[],
): AnchorSet {
  const set = new AnchorSet();
  for (const c of concepts) {
    set.add(
      makeAnchor({
        kind: "concept",
        value: c,
        source: "plan",
        confidence: 0.4,
      }),
    );
  }
  for (const s of synonyms) {
    if (/^(Z|Y|ZZ|YY)/i.test(s) || (/_/i.test(s) && s.length >= 4)) {
      set.add(
        makeAnchor({
          kind: /^[ZY]/i.test(s) ? "field" : "concept",
          value: s,
          source: "plan",
          confidence: 0.45,
        }),
      );
    }
  }
  return set;
}

function seedAnchorsFromPrimary(anchors: AnchorSet, primary: PrimaryAnchor): void {
  if (primary.symbol) {
    anchors.add(
      makeAnchor({
        kind: "symbol",
        value: primary.symbol,
        source: "exact_symbol",
        confidence: 0.99,
        note: "TECHNICAL_SYMBOL Primäranker",
      }),
    );
  }
  for (const obj of primary.objects ?? []) {
    anchors.add(
      makeAnchor({
        kind: "object",
        value: obj,
        source: "exact_symbol",
        confidence: 0.98,
        note: "TECHNICAL_SYMBOL Objekt",
      }),
    );
  }
  if (primary.field) {
    anchors.add(
      makeAnchor({
        kind: "field",
        value: primary.field,
        source: "master_data",
        confidence: 0.95,
        note: `Primäranker ${primary.table}`,
      }),
    );
  }
  if (primary.anchor_type !== "TECHNICAL_SYMBOL" || !primary.objects?.length) {
    anchors.add(
      makeAnchor({
        kind: primary.anchor_type === "TECHNICAL_SYMBOL" ? "symbol" : "table",
        value: primary.table,
        source:
          primary.anchor_type === "TECHNICAL_SYMBOL"
            ? "exact_symbol"
            : "master_data",
        confidence: 0.7,
        note: "Primäranker-Tabelle",
      }),
    );
  }
  for (const needle of primaryAnchorNeedles(primary)) {
    if (needle.includes("=")) {
      anchors.add(
        makeAnchor({
          kind: "key",
          value: needle,
          source: "master_data",
          confidence: 0.8,
        }),
      );
    }
  }
}

type MasterStageResult = StageResult & {
  primary_anchor_detected?: PrimaryAnchor | null;
};

export async function runMultiSourceSearch(
  params: RunMultiSourceSearchParams,
): Promise<MultiSourceRunResult> {
  const started = Date.now();
  const run_id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const question = params.question.trim();

  let project = params.project ?? null;
  if (!project) {
    project = (await fileProjectRepository.getById(params.projectId)) ?? null;
  }
  if (!project) {
    const resolved = await resolveAskLocalProject(params.projectId);
    if (!resolved.ok) {
      const emptyPlan = {
        version: "multi-source-plan-v1" as const,
        question,
        concepts: [],
        synonym_candidates: [],
        source_order: [] as MultiSourceId[],
        max_rounds: 0,
        budgets: {
          exact_symbol: 0,
          master_data: 0,
          control_tables: 0,
          classes: 0,
          programs: 0,
          function_modules: 0,
          relations: 0,
        },
        notes: [resolved.message],
      };
      const specialized = emptySpecializedPlan();
      return {
        run_id,
        project_key: params.projectId,
        question,
        plan: emptyPlan,
        specialized_plan: specialized,
        stages: [],
        anchors: [],
        evidence: {
          items: [],
          by_source: {
            exact_symbol: 0,
            master_data: 0,
            control_tables: 0,
            classes: 0,
            programs: 0,
            function_modules: 0,
            relations: 0,
          },
          omitted: 0,
          ranking_notes: [],
        },
        relations: [],
        coverage: [],
        final_context: "",
        structured_context: {
          question,
          plan_type: "GENERIC",
          primary_anchor: null,
          field_values: [],
          key_contexts: [],
          control_tables: [],
          control_values: [],
          class_evidence: [],
          program_evidence: [],
          function_module_evidence: [],
          relations: [],
          coverage: {},
          open_questions: [resolved.message],
        },
        search_trace: {
          template_type: "GENERIC",
          steps: [],
          steps_completed: [],
          primary_anchor: null,
        },
        answer: null,
        metrics: {
          duration_ms: Date.now() - started,
          stages_run: 0,
          rounds: 0,
          anchors_final: 0,
          evidence_count: 0,
          coverage_summary: [],
          aborted_stages: [],
        },
        log_dir: "",
        status: "error",
        message: resolved.message,
      };
    }
    project = resolved.project;
  }

  const projectKey = project.customer_id || params.projectId;
  const coverage = await diagnoseSourceCoverage(projectKey);
  const bySource = coverageBySource(coverage);

  const { plan: basePlan } = await buildMultiSourceSearchPlan({
    question,
    maxRounds: params.maxRounds,
    enrichWithLlm:
      params.planSeeds != null ? false : params.enrichPlanWithLlm,
  });

  let specialized: SpecializedSearchPlan = emptySpecializedPlan();
  const plan = { ...basePlan, specialized };

  if (params.planSeeds) {
    if (params.planSeeds.concepts?.length) {
      plan.concepts = [
        ...new Set([...params.planSeeds.concepts, ...plan.concepts]),
      ].slice(0, 32);
    }
    if (params.planSeeds.synonyms?.length) {
      plan.synonym_candidates = [
        ...new Set([
          ...params.planSeeds.synonyms,
          ...plan.synonym_candidates,
        ]),
      ].slice(0, 48);
    }
    for (const n of params.planSeeds.notes ?? []) plan.notes.push(n);
    for (const h of params.planSeeds.hypotheses_to_verify ?? []) {
      plan.notes.push(`ZU PRÜFEN (kein Fakt): ${h}`);
    }
    for (const soft of params.planSeeds.soft_context ?? []) {
      plan.notes.push(`Organisationskontext (weich): ${soft}`);
    }
  }

  // Final retrieval concept hygiene (stopwords / soft object-type words)
  {
    const techSymbols = extractTechnicalSymbols(question);
    plan.concepts = filterRetrievalConcepts(plan.concepts, {
      dropObjectTypeWords: techSymbols.length > 0,
    });
    plan.synonym_candidates = filterRetrievalConcepts(plan.synonym_candidates, {
      dropObjectTypeWords: techSymbols.length > 0,
    });
  }

  const anchors = seedAnchorsFromPlan(plan.concepts, plan.synonym_candidates);
  const stages: StageResult[] = [];
  const allEvidence: StageEvidenceItem[] = [];
  const aborted: string[] = [];
  let rounds = 0;
  let primaryAnchor: PrimaryAnchor | null = null;

  const maxRounds = plan.max_rounds;

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    const priorSize = anchors.size;
    const stageOrder = stageOrderForRun(plan, specialized, round);

    for (const stageId of stageOrder) {
      if (stageId === "master_data" && round > 1) continue;
      if (stageId === "exact_symbol" && round > 1) continue;
      // Technical symbol primary: skip broad master_data concept scan
      if (
        stageId === "master_data" &&
        specialized.plan_type === "TECHNICAL_SYMBOL_TO_PROCESS"
      ) {
        continue;
      }

      const cov = bySource[stageId];
      if (!cov) continue;

      let stageResult: StageResult;

      if (stageId === "exact_symbol") {
        stageResult = await runExactSymbolStage({
          projectKey,
          plan,
          anchors,
          coverage,
          round,
        });
        // 1) TECHNICAL_SYMBOL primary from exact object-name hits (beats MD/CT)
        // 2) else MASTER_DATA_BUSINESS_FIELD from exact MD hits
        if (!primaryAnchor) {
          const tech = detectTechnicalSymbolPrimary(stageResult.hits, plan);
          if (tech) {
            primaryAnchor = tech;
            specialized = buildSpecializedPlan({
              plan,
              primaryAnchor,
              planType: "TECHNICAL_SYMBOL_TO_PROCESS",
            });
            plan.specialized = specialized;
            plan.notes.push(...specialized.notes);
            seedAnchorsFromPrimary(anchors, primaryAnchor);
          } else {
            const detected = detectPrimaryAnchorFromMasterHits(
              stageResult.hits,
              plan,
            );
            if (detected) {
              primaryAnchor = detected;
              specialized = buildSpecializedPlan({
                plan,
                primaryAnchor,
                planType: "MASTER_FIELD_TO_PROCESS",
              });
              plan.specialized = specialized;
              plan.notes.push(...specialized.notes);
              seedAnchorsFromPrimary(anchors, primaryAnchor);
            }
          }
        }
      } else if (stageId === "master_data") {
        const mdResult = (await runMasterDataStage({
          projectKey,
          plan,
          anchors,
          coverage: cov,
          round,
          specialized,
        })) as MasterStageResult;

        if (mdResult.primary_anchor_detected && !primaryAnchor) {
          const exactHits =
            stages.find((s) => s.stage === "exact_symbol")?.hits ?? [];
          const strongExact = hasStrongExactSymbolCodeHit(exactHits, plan);
          const candidate = mdResult.primary_anchor_detected;
          const symbols = extractTechnicalSymbols(plan.question).map(
            (s) => s.norm,
          );
          const mdMatchesSymbol =
            symbols.length === 0 ||
            symbols.some((sym) => {
              const blob =
                `${candidate.table} ${candidate.field ?? ""} ${candidate.description ?? ""}`.toUpperCase();
              return blob.includes(sym);
            });
          if (strongExact && !mdMatchesSymbol) {
            plan.notes.push(
              `Stammdaten-Primäranker ${candidate.table}-${candidate.field} übersprungen — Exact-Symbol-Code-Treffer ohne Feldbezug zum Fragesymbol.`,
            );
          } else {
            primaryAnchor = candidate;
            specialized = buildSpecializedPlan({
              plan,
              primaryAnchor,
              planType: "MASTER_FIELD_TO_PROCESS",
            });
            plan.specialized = specialized;
            plan.notes.push(...specialized.notes);
            seedAnchorsFromPrimary(anchors, primaryAnchor);
          }
        }
        stageResult = mdResult;
      } else if (stageId === "control_tables") {
        stageResult = await runControlTablesStage({
          projectKey,
          project,
          plan,
          anchors,
          coverage: cov,
          round,
          specialized,
        });

        if (!primaryAnchor && round === 1) {
          // Exact technical code hits must not be overridden by weak CT concept matches.
          const exactHits = stages.find((s) => s.stage === "exact_symbol")?.hits ?? [];
          if (!hasStrongExactSymbolCodeHit(exactHits, plan)) {
            const ctAnchor = detectControlTableAnchor(stageResult.hits, plan);
            if (ctAnchor) {
              primaryAnchor = ctAnchor;
              specialized = buildSpecializedPlan({
                plan,
                primaryAnchor,
                planType: "CONTROL_TABLE_TO_PROCESS",
              });
              plan.specialized = specialized;
              plan.notes.push(...specialized.notes);
              seedAnchorsFromPrimary(anchors, primaryAnchor);
            }
          } else {
            plan.notes.push(
              "Exact-Symbol-Code-Treffer vorhanden — schwacher Steuertabellen-Primäranker übersprungen.",
            );
          }
        }
      } else if (stageId === "classes") {
        stageResult = await runClassesStage({
          projectKey,
          project,
          plan,
          anchors,
          coverage: cov,
          round,
          specialized,
        });
      } else if (stageId === "programs") {
        stageResult = await runProgramsStage({
          projectKey,
          plan,
          anchors,
          coverage: cov,
          round,
          specialized,
        });
      } else if (stageId === "function_modules") {
        stageResult = await runFunctionModulesStage({
          projectKey,
          plan,
          anchors,
          coverage: cov,
          round,
          specialized,
        });
      } else {
        stageResult = await runRelationsExpansionStage({
          projectKey,
          plan,
          anchors,
          coverage: cov,
          round,
          priorAnchorCount: priorSize,
        });
      }

      stages.push(stageResult);
      allEvidence.push(...stageResult.hits);
      const neu = anchors.addMany(stageResult.new_anchors);
      if (stageResult.abort) {
        aborted.push(`${stageId}@r${round}:${stageResult.abort_reason ?? "abort"}`);
      }

      if (
        stageId === "relations" &&
        stageResult.abort &&
        neu.length === 0 &&
        round > 1
      ) {
        break;
      }
    }

    const anchorCoverage = evaluatePrimaryAnchorCoverage(stages, specialized);

    // With primary anchor: do not stop early until minimum coverage checked
    if (
      specialized.plan_type === "MASTER_FIELD_TO_PROCESS" &&
      !anchorCoverage.sufficient &&
      round < maxRounds
    ) {
      aborted.push(
        `round_continue@r${round}:Primäranker-Abdeckung fehlt: ${anchorCoverage.missing.join(",")}`,
      );
      continue;
    }

    const gained = anchors.size - priorSize;
    if (round >= 1 && gained <= 0 && round < maxRounds) {
      aborted.push(`round_stop@r${round}:keine neuen Anker`);
      break;
    }
  }

  const evidence = bundleEvidence({ items: allEvidence, plan });
  const relations = evidence.items.filter((i) => i.source === "relations");
  const coverageNotesMap: Record<string, string> = {};
  for (const c of coverage) {
    coverageNotesMap[c.source] = `${c.status} — ${c.diagnosis}`;
  }

  const anchorCoverageFinal = evaluatePrimaryAnchorCoverage(stages, specialized);

  const structured_context = buildStructuredContext({
    question,
    specialized,
    evidence,
    stages,
    coverageNotes: coverageNotesMap,
    anchorCoverage: anchorCoverageFinal,
  });

  const discardedFromNotes = evidence.ranking_notes
    .filter((n) => n.startsWith("Verworfen"))
    .flatMap((n) => {
      const part = n.replace(/^Verworfen[^:]*:\s*/, "");
      return part
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20)
        .map((title) => ({
          title,
          source: title.split(":")[0] ?? "unknown",
          reason: "kein Bezug zum technischen Symbol",
        }));
    });

  const extractedTokens = extractTechnicalSymbols(question).map((s) => s.norm);

  const final_context = buildFinalContext({
    question,
    plan,
    evidence,
    coverageNotes: coverage.map(
      (c) =>
        `${c.source}: ${c.status} — ${c.diagnosis} (≈${c.record_count_estimate ?? "?"} @ ${c.expected_path})`,
    ),
    structured: structured_context,
    specialized,
  });

  let answer = null;
  let synthTokens: { input: number; output: number } | undefined;
  if (params.synthesize !== false) {
    try {
      const synth = await synthesizeMultiSourceAnswer({
        question,
        finalContext: final_context,
        structuredContext: structured_context,
      });
      answer = synth.answer;
      synthTokens = synth.tokens;
    } catch (e) {
      answer = {
        direct_answer: "Synthese fehlgeschlagen.",
        reasoning: e instanceof Error ? e.message : "unknown",
        open_questions: structured_context.open_questions,
        sources_used: [],
      };
    }
  }

  // Deterministic framing when TECHNICAL_SYMBOL and synthesis omitted/weak
  if (
    specialized.plan_type === "TECHNICAL_SYMBOL_TO_PROCESS" &&
    primaryAnchor?.symbol &&
    primaryAnchor.objects?.length
  ) {
    const preamble = [
      `Ein eindeutiges ${primaryAnchor.user_object_type_guess ?? "Nachrichten"}objekt ${primaryAnchor.symbol} wurde nicht gefunden.`,
      `Es existieren jedoch folgende technische Objekte mit ${primaryAnchor.symbol} im Namen: ${primaryAnchor.objects.slice(0, 8).join(", ")}.`,
    ].join(" ");
    if (!answer) {
      answer = {
        direct_answer: preamble,
        reasoning: "Deterministische Exact-Symbol-Zusammenfassung (ohne LLM).",
        open_questions: structured_context.open_questions,
        sources_used: primaryAnchor.objects.slice(0, 8),
      };
    } else if (
      !primaryAnchor.objects.some((o) =>
        (answer!.direct_answer ?? "").toUpperCase().includes(o.toUpperCase()),
      )
    ) {
      answer = {
        ...answer,
        direct_answer: `${preamble}\n\n${answer.direct_answer}`,
        sources_used: [
          ...new Set([
            ...primaryAnchor.objects.slice(0, 8),
            ...(answer.sources_used ?? []),
          ]),
        ],
      };
    }
  }

  const search_trace = buildSearchTrace({
    specialized,
    stages,
    extractedTokens,
    discardedSemanticHits: discardedFromNotes,
    evidenceItems: evidence.items,
    finalAnswerPreview: answer?.direct_answer?.slice(0, 500),
  });

  const result: MultiSourceRunResult = {
    run_id,
    project_key: projectKey,
    question,
    plan,
    specialized_plan: specialized,
    stages,
    anchors: anchors.list(),
    evidence,
    relations,
    coverage,
    final_context,
    structured_context,
    search_trace,
    answer,
    metrics: {
      duration_ms: Date.now() - started,
      stages_run: stages.length,
      rounds,
      anchors_final: anchors.size,
      evidence_count: evidence.items.length,
      coverage_summary: coverage,
      aborted_stages: aborted,
      synthesis_tokens: synthTokens,
      compare_note: params.compareNote,
      plan_type: specialized.plan_type,
      primary_anchor: primaryAnchor,
    },
    log_dir: "",
    status:
      evidence.items.length === 0
        ? "insufficient"
        : answer
          ? "ok"
          : "ok",
    message:
      evidence.items.length === 0
        ? "Keine Multi-Source-Evidenz gefunden."
        : undefined,
  };

  const persisted = persistMultiSourceRun(result);
  result.log_dir = persisted.log_dir;
  return result;
}
