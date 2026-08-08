/**
 * Analysis-Planner KI — structured gap analysis, NEVER the final user answer.
 */
import { z } from "zod";
import { OpenAIProvider } from "@/lib/ai/openaiProvider";
import { AI_CONFIG } from "@/lib/ai/config";
import type {
  ResearchPlannerDecision,
  ResearchActionType,
} from "@/lib/knowledge/fullAnalysisResearch/types";

const ACTION_TYPES = [
  "EXPAND_GRAPH",
  "ANALYZE_METHODS",
  "SEARCH_CONFIG",
  "SEARCH_DDIC",
  "SEARCH_MASTERDATA",
  "SEARCH_CODE",
] as const satisfies readonly ResearchActionType[];

const PlannerSchema = z.object({
  status: z.enum(["COMPLETE", "INCOMPLETE"]),
  known_claims: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  next_actions: z
    .array(
      z.object({
        type: z.enum(ACTION_TYPES),
        targets: z.array(z.string()).default([]),
        reason: z.string().default(""),
      }),
    )
    .default([]),
});

const SYSTEM = `Du bist der Analysis-Planner für eine iterative SAP-Wissens-Vollanalyse.
Du erzeugst KEINE finale Nutzerantwort und keine Report-Prosa.

Aufgabe: Bewerte die vorhandene Evidence und entscheide, ob die Frage bereits
belastbar beantwortbar ist oder welche gezielten nächsten Retrieval-/Analyse-Aktionen
noch fehlen.

Regeln:
- status=COMPLETE nur wenn die Kernfrage mit belegter Evidence beantwortbar ist
  (Lücken dürfen bleiben, wenn sie ehrlich als offen markiert sind und die
  Hauptfrage trotzdem tragfähig beantwortet werden kann).
- status=INCOMPLETE wenn wesentliche Teilfragen offen sind und Aktionen helfen können.
- known_claims: nur Aussagen, die aus der Evidence ableitbar/belegt wirken — keine Erfindung.
- open_questions: konkrete technische Lücken.
- next_actions: maximal 4, präzise targets (Klassen, Methoden, Tabellen, Tokens aus Evidence/Frage).
- Keine kundenspezifischen Sonderregeln, keine Hardcodes für einzelne Produkte.
- Bei Prozessfragen (wie funktioniert X?) prüfe generisch, ob Evidence zu Einstieg,
  Geltungsbereich, Auslöser, Bedingungen, Verarbeitung, Config, Wirkung vorhanden ist —
  ohne diese Labels zu erzwingen, wenn die Evidence sie nicht stützt.
- SEARCH_DDIC: nur vorhandene Indizes nutzen (kein Export anfordern).
- ANALYZE_METHODS: nur wenn fehlende Method-Analysen die Lücke schließen könnten.
- Antworte NUR mit JSON gemäß Schema.`;

export async function runAnalysisPlanner(params: {
  question: string;
  iteration: number;
  evidenceSummary: string;
  seeds: string[];
  previousOpenQuestions: string[];
  previousKnownClaims: string[];
  remainingBudgets: {
    iterations_left: number;
    analyses_left: number;
    openai_calls_left: number;
  };
}): Promise<{
  decision: ResearchPlannerDecision;
  tokens: { input: number; output: number };
  model: string;
}> {
  const provider = new OpenAIProvider();
  const model = AI_CONFIG.chatModel;
  const user = JSON.stringify(
    {
      question: params.question,
      iteration: params.iteration,
      seeds: params.seeds.slice(0, 40),
      previous_known_claims: params.previousKnownClaims.slice(0, 30),
      previous_open_questions: params.previousOpenQuestions.slice(0, 30),
      remaining_budgets: params.remainingBudgets,
      evidence_summary: params.evidenceSummary.slice(0, 24_000),
    },
    null,
    2,
  );

  const raw = await provider.generateStructured({
    schema: PlannerSchema,
    schemaName: "full_analysis_research_planner_v1",
    system: SYSTEM,
    user,
    model,
  });
  const parsed = PlannerSchema.parse(raw);

  // Cap actions
  const next_actions = parsed.next_actions.slice(0, 4).map((a) => ({
    type: a.type as ResearchActionType,
    targets: (a.targets ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 12),
    reason: String(a.reason ?? "").trim(),
  }));

  // COMPLETE ⇒ no further actions
  const decision: ResearchPlannerDecision = {
    status: parsed.status,
    known_claims: (parsed.known_claims ?? [])
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 40),
    open_questions: (parsed.open_questions ?? [])
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 40),
    next_actions: parsed.status === "COMPLETE" ? [] : next_actions,
  };

  return {
    decision,
    tokens: { input: 0, output: 0 },
    model,
  };
}
