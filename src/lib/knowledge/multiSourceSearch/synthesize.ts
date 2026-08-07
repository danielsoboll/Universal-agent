/**
 * KI synthesis ONLY after curated multi-source evidence is ready.
 */
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { AI_CONFIG } from "@/lib/ai/config";
import type {
  MultiSourceAnswer,
  StructuredSearchContext,
} from "@/lib/knowledge/multiSourceSearch/types";

const synthesisSchema = z.object({
  direct_answer: z.string(),
  reasoning: z.string(),
  open_questions: z.array(z.string()),
  sources_used: z.array(z.string()),
});

const DEFAULT_CONTEXT_LIMIT = 12_000;

export type SynthesisOpenAiInput = {
  model: string;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
  context_char_limit: number;
  context_chars_before_slice: number;
  context_chars_after_slice: number;
  truncated: boolean;
};

export async function synthesizeMultiSourceAnswer(params: {
  question: string;
  finalContext: string;
  structuredContext?: StructuredSearchContext;
  /** Override evidence context char limit (default 12000). */
  contextCharLimit?: number;
}): Promise<{
  answer: MultiSourceAnswer;
  tokens: { input: number; output: number };
  model: string;
  openai_input: SynthesisOpenAiInput;
  raw_content: string | null;
}> {
  const limit = params.contextCharLimit ?? DEFAULT_CONTEXT_LIMIT;
  const before = params.finalContext.length;
  const sliced = params.finalContext.slice(0, limit);
  const truncated = before > sliced.length;

  const systemContent = [
    "Du beantwortest SAP-Fachfragen ausschließlich auf Basis der gelieferten Multi-Source-Evidenz.",
    "Wenn ein Evidence Package / Konfigurationsblock vorliegt: nutze Outputarten, Texte, Medium, Programme, Routinen, IDoc- und Partnerdaten daraus als bestätigte Fakten.",
    "Medium fachlich formulieren: „Als Verarbeitungsmedium ist NACHA=<Code> mit der Bedeutung ‚<Text>‘ hinterlegt.“ Nicht behaupten, GENERIC_SAP_MAPPING sei eine fachliche Funktion.",
    "Keine Knoten oder Relationen mit '?' als belegt darstellen; solche gehören nur zu offenen technischen Punkten.",
    "Wenn ein Primäranker (MASTER_DATA_BUSINESS_FIELD) gesetzt ist, erkläre den Prozess entlang dieser Evidenzkette.",
    "Erfinde keine fehlenden Verbindungen zwischen Feld, Code und Steuertabellen.",
    "Wenn Steuerungs-Tabellen (z.B. Profile/Zeilen) in der Evidenz stehen, erkläre deren Rolle konkret (Felder/Werte).",
    "Trenne bestätigt (aus Evidenz) und vermutet klar.",
    "Keine Kundennamen oder Prozesse erfinden, die nicht in der Evidenz stehen.",
    "Wenn Evidenz dünn ist: klar sagen, was fehlt (Master-Felder, Steuerzeilen, Code).",
    "Nenne vorhandene verwandte Programme/Funktionsbausteine/Methoden mit Symbol-Bezug, sofern in der Evidenz.",
    "Wenn proven claims „Verwandtes PROGRAM/FUNCTION_MODULE/METHOD“ enthalten: diese Objekte in der Antwort kurz auflisten.",
    "Antwort auf Deutsch.",
  ].join(" ");

  const userContent = [
    `Frage: ${params.question}`,
    "",
    params.structuredContext?.primary_anchor
      ? `Primäranker: ${JSON.stringify(params.structuredContext.primary_anchor)}`
      : null,
    "",
    "Evidenzkontext:",
    sliced,
  ]
    .filter(Boolean)
    .join("\n");

  const openai_input: SynthesisOpenAiInput = {
    model: AI_CONFIG.chatModel,
    temperature: 0,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    context_char_limit: limit,
    context_chars_before_slice: before,
    context_chars_after_slice: sliced.length,
    truncated,
  };

  if (!process.env.OPENAI_API_KEY) {
    return {
      answer: {
        direct_answer:
          "Synthese übersprungen (kein OPENAI_API_KEY). Evidenz liegt im Run-Log.",
        reasoning: "Nur Retrieval/Evidence-Pipeline ausgeführt.",
        open_questions: ["LLM-Key setzen für Antwortsynthese."],
        sources_used: [],
      },
      tokens: { input: 0, output: 0 },
      model: "none",
      openai_input,
      raw_content: null,
    };
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 90_000,
    maxRetries: AI_CONFIG.maxRetries,
  });

  const completion = await client.chat.completions.parse({
    model: AI_CONFIG.chatModel,
    temperature: 0,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    response_format: zodResponseFormat(synthesisSchema, "multi_source_answer"),
  });

  const parsed = completion.choices[0]?.message?.parsed;
  const validated = synthesisSchema.parse(parsed);
  const raw_content =
    completion.choices[0]?.message?.content ??
    (parsed ? JSON.stringify(parsed) : null);
  return {
    answer: {
      ...validated,
      model: AI_CONFIG.chatModel,
    },
    tokens: {
      input: completion.usage?.prompt_tokens ?? 0,
      output: completion.usage?.completion_tokens ?? 0,
    },
    model: AI_CONFIG.chatModel,
    openai_input,
    raw_content,
  };
}
