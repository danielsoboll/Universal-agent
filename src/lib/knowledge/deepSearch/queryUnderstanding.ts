/**
 * KI Query Understanding for deep_search only.
 * Separates anchors, context, hypotheses, assumed types, and requested output.
 */
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { AI_CONFIG } from "@/lib/ai/config";
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";
import {
  DEEP_SEARCH_INTENTS,
  PREFERRED_SEARCH_PLANS,
  QUERY_UNDERSTANDING_PROMPT_VERSION,
  type AssumedObjectType,
  type DeepSearchIntent,
  type PreferredSearchPlan,
  type QueryUnderstanding,
  type UserHypothesis,
} from "@/lib/knowledge/deepSearch/types";
import {
  filterRetrievalConcepts,
  isQueryStopword,
  QUERY_STOPWORDS,
} from "@/lib/knowledge/queryStopwords";

const IRRELEVANT = QUERY_STOPWORDS;

const llmSchema = z.object({
  intent: z.enum(DEEP_SEARCH_INTENTS),
  technical_tokens: z.array(z.string()).default([]),
  business_concepts: z.array(z.string()).default([]),
  organization_context: z.array(z.string()).default([]),
  process_context: z.array(z.string()).default([]),
  user_hypotheses: z
    .array(
      z.object({
        text: z.string(),
        status: z
          .enum(["TO_BE_VERIFIED", "ASSUMED", "REJECTED_AS_FACT"])
          .default("TO_BE_VERIFIED"),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .default([]),
  assumed_object_types: z
    .array(
      z.object({
        type: z.string(),
        confidence: z.enum(["low", "medium", "high"]).default("low"),
        raw: z.string().nullable().default(null),
      }),
    )
    .default([]),
  requested_output: z.array(z.string()).default([]),
  preferred_search_plan: z.enum(PREFERRED_SEARCH_PLANS),
  search_plan_steps: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

const SYSTEM = [
  "Du analysierst SAP-/Fachfragen für eine mehrstufige Tiefensuche.",
  "Trenne strikt:",
  "- technical_tokens: Z-/Y-/ZZ-Namen, Tabellen, Felder, FuBas, Klassen (keine normalen Wörter)",
  "- business_concepts: Fachbegriffe aus der Frage (keine Kundennamen erfinden)",
  "- organization_context: Organisation/Kunde als KONTEXT, nicht als Suchanker erzwingen",
  "- process_context: Prozessrahmen (Auftrag, Lieferung, …)",
  "- user_hypotheses: Annahmen des Nutzers — Status immer TO_BE_VERIFIED, nie als Fakt; Text wörtlich aus der Frage ableiten",
  "- assumed_object_types: vom Nutzer vermuteter Objekttyp (Nachricht, Tabelle, …) mit oft niedriger confidence",
  "- requested_output: gewünschte Antwortform (Erklärung, Verifikation, Trace, …)",
  "Ignoriere Fragewörter wie wie/was/genau.",
  "Wenn der Nutzer einen Objekttyp nennt und ein technisches Token: Objekttyp darf ungenau sein.",
  "Intent ENTITY_LOOKUP bei Überblickfragen zu einem technischen Token.",
  "Intent VERIFY_AND_EXPLAIN_PROCESS wenn Prozesshypothese + Fachkonzept in der Frage stehen.",
  "preferred_search_plan: TECHNICAL_SYMBOL_TO_PROCESS bei starken technischen Tokens;",
  "MASTER_FIELD_TO_PROCESS bei Stammdaten-/Feld-/Steuerungsfragen mit Fachkonzept.",
  "Keine kundenspezifischen Sonderfälle, festen Feldnamen oder Markennamen in die Analyse einbauen.",
].join(" ");

/**
 * Generic heuristic fallback when LLM is unavailable.
 * Uses only question tokens + generic linguistic cues — no customer fixtures.
 */
function heuristicFallback(question: string): z.infer<typeof llmSchema> {
  const symbols = extractTechnicalSymbols(question).map((s) => s.norm);
  const lower = question.toLowerCase();
  const hasProcess =
    /funktioniert|prozess|gesteuert|steuerung|greift|ablauf|wie\s+genau/i.test(
      question,
    );
  const hasHypothesis =
    /anscheinend|vermutlich|scheint|wohl|angeblich|gesteuert|offenbar/i.test(
      question,
    );
  const hasMasterCue =
    /stamm|feld|kennzeichen|steuerung|customizing|kunden|material|lieferant/i.test(
      lower,
    );

  let intent: DeepSearchIntent = "ENTITY_LOOKUP";
  let plan: PreferredSearchPlan = "GENERIC_MULTI_SOURCE";
  if (symbols.length > 0 && !hasMasterCue) {
    intent = "ENTITY_LOOKUP";
    plan = "TECHNICAL_SYMBOL_TO_PROCESS";
  } else if (hasProcess && hasHypothesis) {
    intent = "VERIFY_AND_EXPLAIN_PROCESS";
    plan = "MASTER_FIELD_TO_PROCESS";
  } else if (hasProcess || hasMasterCue) {
    intent = hasHypothesis ? "VERIFY_AND_EXPLAIN_PROCESS" : "PROCESS_EXPLANATION";
    plan = "MASTER_FIELD_TO_PROCESS";
  } else if (symbols.length > 0) {
    intent = "ENTITY_LOOKUP";
    plan = "TECHNICAL_SYMBOL_TO_PROCESS";
  }

  const assumed: AssumedObjectType[] = [];
  for (const [re, type] of [
    [/\bnachricht(?:en)?\b/i, "message"],
    [/\bmessage\b/i, "message"],
    [/\bmeldung\b/i, "message"],
    [/\btabelle\b/i, "table"],
    [/\bklasse\b/i, "class"],
    [/\bprogramm\b/i, "program"],
    [/\bfunktionsbaustein|fuba\b/i, "function_module"],
  ] as const) {
    if (re.test(question)) {
      assumed.push({ type, confidence: "low", raw: type as string | null });
    }
  }

  // Extract hypothesis phrases generically from cue clauses (not fixed fixture text)
  const hypotheses: UserHypothesis[] = [];
  if (hasHypothesis) {
    const m = question.match(
      /(?:anscheinend|vermutlich|scheint|wohl|angeblich)[^.?!]{8,160}/i,
    );
    if (m) {
      hypotheses.push({
        text: m[0]!.trim(),
        status: "TO_BE_VERIFIED",
        confidence: 0.5,
      });
    }
  }

  // Proper-noun-like tokens as soft org context (capitalized words ≥4, not stopwords)
  const orgStop = new Set([
    "was",
    "wie",
    "beim",
    "über",
    "nach",
    "diese",
    "dieser",
    "welches",
    "welche",
  ]);
  const org: string[] = [];
  for (const m of question.matchAll(/\b([A-ZÄÖÜ][a-zäöüß]{3,})\b/g)) {
    const w = m[1]!;
    if (!orgStop.has(w.toLowerCase())) org.push(w);
  }

  // Multi-word noun phrases as business concepts (length ≥2 content words)
  const concepts: string[] = [];
  for (const m of lower.matchAll(
    /\b([a-zäöüß]{4,}(?:\s+[a-zäöüß]{3,}){1,3})\b/g,
  )) {
    const phrase = m[1]!;
    if (phrase.split(/\s+/).every((p) => !IRRELEVANT.has(p))) {
      concepts.push(phrase);
    }
  }

  const processCtx: string[] = [];
  if (/\bauftrag/i.test(lower)) processCtx.push("Auftragsverarbeitung");
  if (/\bliefer/i.test(lower)) processCtx.push("Lieferprozess");
  if (/\bfaktur|rechnung/i.test(lower)) processCtx.push("Fakturierung");

  return {
    intent,
    technical_tokens: symbols,
    business_concepts: [...new Set(concepts)].slice(0, 8),
    organization_context: [...new Set(org)].slice(0, 6),
    process_context: processCtx,
    user_hypotheses: hypotheses,
    assumed_object_types: assumed.map((a) => ({
      type: a.type,
      confidence: a.confidence,
      raw: a.raw ?? null,
    })),
    requested_output:
      intent === "VERIFY_AND_EXPLAIN_PROCESS"
        ? ["process_explanation", "verification"]
        : intent === "ENTITY_LOOKUP"
          ? ["entity_overview", "object_classification"]
          : ["explanation"],
    preferred_search_plan: plan,
    search_plan_steps:
      plan === "TECHNICAL_SYMBOL_TO_PROCESS"
        ? [
            "exact_symbol_all_sources",
            "classify_found_objects",
            "expand_callers_callees",
            "expand_data_relations",
            "synthesize",
          ]
        : plan === "MASTER_FIELD_TO_PROCESS"
          ? [
              "find_master_field",
              "load_field_values",
              "find_exact_code_usage",
              "find_related_control_tables",
              "follow_calls_and_relations",
              "synthesize",
            ]
          : ["broad_concept_search", "expand_anchors", "synthesize"],
    warnings: ["Heuristic Query-Understanding (kein/fehlerhaftes LLM)."],
    confidence: 0.45,
  };
}

/** Rule-based merge: deterministic technical tokens always win. */
export function validateAndEnrichQueryUnderstanding(
  question: string,
  raw: z.infer<typeof llmSchema>,
  meta: { model: string; input: number; output: number },
): QueryUnderstanding {
  const detTokens = extractTechnicalSymbols(question).map((s) => s.norm);
  const tokens = [
    ...new Set(
      [...detTokens, ...raw.technical_tokens.map((t) => t.trim().toUpperCase())].filter(
        (t) => t.length >= 2 && !IRRELEVANT.has(t.toLowerCase()),
      ),
    ),
  ];

  const warnings = [...raw.warnings];
  for (const h of raw.user_hypotheses) {
    if (h.status !== "TO_BE_VERIFIED" && h.status !== "REJECTED_AS_FACT") {
      h.status = "TO_BE_VERIFIED";
      warnings.push(`Hypothese auf TO_BE_VERIFIED gesetzt: ${h.text.slice(0, 80)}`);
    }
  }

  // Strong technical tokens → prefer TECHNICAL_SYMBOL unless business/master cues dominate
  let preferred = raw.preferred_search_plan;
  let intent = raw.intent;
  const hasBusinessCue =
    raw.business_concepts.length > 0 ||
    raw.preferred_search_plan === "MASTER_FIELD_TO_PROCESS" ||
    intent === "VERIFY_AND_EXPLAIN_PROCESS" ||
    intent === "PROCESS_EXPLANATION" ||
    intent === "VALUE_EXPLANATION";
  if (
    tokens.length > 0 &&
    preferred === "GENERIC_MULTI_SOURCE" &&
    !hasBusinessCue
  ) {
    preferred = "TECHNICAL_SYMBOL_TO_PROCESS";
    warnings.push("Plan auf TECHNICAL_SYMBOL_TO_PROCESS angehoben (technische Tokens).");
  }
  if (
    tokens.length > 0 &&
    intent === "PROCESS_EXPLANATION" &&
    raw.assumed_object_types.some((a) =>
      /message|nachricht|meldung|table|tabelle|class|klasse|programm/i.test(
        a.type,
      ),
    ) &&
    raw.business_concepts.length === 0
  ) {
    intent = "ENTITY_LOOKUP";
    preferred = "TECHNICAL_SYMBOL_TO_PROCESS";
    warnings.push(
      "Intent ENTITY_LOOKUP: vermuteter Objekttyp + technisches Token ohne Fachkonzept.",
    );
  }

  const assumed = raw.assumed_object_types.map((a) => {
    let confidence = a.confidence;
    // Object-type guesses from natural language are inherently low/medium
    if (/message|nachricht|meldung|table|tabelle/i.test(a.type)) {
      confidence = "low";
    } else if (confidence === "high") {
      confidence = "medium";
    }
    return { ...a, confidence };
  });

  const primaryAssumed = assumed[0];

  let steps = raw.search_plan_steps;
  if (!steps.length) {
    steps =
      preferred === "TECHNICAL_SYMBOL_TO_PROCESS"
        ? [
            "exact_symbol_all_sources",
            "classify_found_objects",
            "expand_callers_callees",
            "expand_data_relations",
            "synthesize",
          ]
        : preferred === "MASTER_FIELD_TO_PROCESS"
          ? [
              "find_master_field",
              "load_field_values",
              "find_exact_code_usage",
              "find_related_control_tables",
              "follow_calls_and_relations",
              "synthesize",
            ]
          : ["broad_concept_search", "expand_anchors", "synthesize"];
  }

  const irrelevant = question
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/i)
    .filter((w) => isQueryStopword(w));

  const businessConcepts = filterRetrievalConcepts(raw.business_concepts);

  return {
    original_question: question,
    intent,
    technical_tokens: tokens,
    business_concepts: businessConcepts,
    organization_context: raw.organization_context,
    process_context: filterRetrievalConcepts(raw.process_context),
    user_hypotheses: raw.user_hypotheses.map((h) => ({
      ...h,
      status: "TO_BE_VERIFIED" as const,
    })),
    assumed_object_types: assumed.map((a) => ({
      type: a.type,
      confidence: a.confidence,
      raw: a.raw ?? null,
    })),
    user_assumed_type: primaryAssumed?.type,
    assumed_type_confidence: primaryAssumed?.confidence ?? "low",
    requested_output: raw.requested_output,
    preferred_search_plan: preferred,
    search_plan_steps: steps,
    irrelevant_question_words: [...new Set(irrelevant)],
    warnings,
    model: meta.model,
    prompt_version: QUERY_UNDERSTANDING_PROMPT_VERSION,
    confidence: Math.min(1, Math.max(0, raw.confidence)),
    token_usage: { input: meta.input, output: meta.output },
  };
}

export async function runQueryUnderstanding(
  question: string,
): Promise<QueryUnderstanding> {
  const q = question.trim();
  if (!process.env.OPENAI_API_KEY) {
    return validateAndEnrichQueryUnderstanding(q, heuristicFallback(q), {
      model: "heuristic",
      input: 0,
      output: 0,
    });
  }

  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60_000,
      maxRetries: AI_CONFIG.maxRetries,
    });
    const completion = await client.chat.completions.parse({
      model: AI_CONFIG.chatModel,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            `Frage: ${q}`,
            "",
            "Bereits deterministisch erkannte technische Tokens:",
            extractTechnicalSymbols(q)
              .map((s) => s.norm)
              .join(", ") || "(keine)",
            "",
            `prompt_version=${QUERY_UNDERSTANDING_PROMPT_VERSION}`,
          ].join("\n"),
        },
      ],
      response_format: zodResponseFormat(llmSchema, "query_understanding"),
    });
    const parsed = llmSchema.parse(completion.choices[0]?.message?.parsed);
    return validateAndEnrichQueryUnderstanding(q, parsed, {
      model: AI_CONFIG.chatModel,
      input: completion.usage?.prompt_tokens ?? 0,
      output: completion.usage?.completion_tokens ?? 0,
    });
  } catch (e) {
    const fb = heuristicFallback(q);
    fb.warnings.push(
      `LLM Query-Understanding fehlgeschlagen: ${e instanceof Error ? e.message : e}`,
    );
    return validateAndEnrichQueryUnderstanding(q, fb, {
      model: "heuristic-fallback",
      input: 0,
      output: 0,
    });
  }
}
