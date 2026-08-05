/**
 * KI synthesis ONLY after curated multi-source evidence is ready.
 */
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { AI_CONFIG } from "@/lib/ai/config";
import type { MultiSourceAnswer, StructuredSearchContext } from "@/lib/knowledge/multiSourceSearch/types";

const synthesisSchema = z.object({
  direct_answer: z.string(),
  reasoning: z.string(),
  open_questions: z.array(z.string()),
  sources_used: z.array(z.string()),
});

export async function synthesizeMultiSourceAnswer(params: {
  question: string;
  finalContext: string;
  structuredContext?: StructuredSearchContext;
}): Promise<{
  answer: MultiSourceAnswer;
  tokens: { input: number; output: number };
  model: string;
}> {
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
      {
        role: "system",
        content: [
          "Du beantwortest SAP-Fachfragen ausschließlich auf Basis der gelieferten Multi-Source-Evidenz.",
          "Wenn ein Primäranker (MASTER_DATA_BUSINESS_FIELD) gesetzt ist, erkläre den Prozess entlang dieser Evidenzkette.",
          "Erfinde keine fehlenden Verbindungen zwischen Feld, Code und Steuertabellen.",
          "Wenn Steuerungs-Tabellen (z.B. Profile/Zeilen) in der Evidenz stehen, erkläre deren Rolle konkret (Felder/Werte).",
          "Trenne bestätigt (aus Evidenz) und vermutet klar.",
          "Keine Kundennamen oder Prozesse erfinden, die nicht in der Evidenz stehen.",
          "Wenn Evidenz dünn ist: klar sagen, was fehlt (Master-Felder, Steuerzeilen, Code).",
          "Antwort auf Deutsch.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Frage: ${params.question}`,
          "",
          params.structuredContext?.primary_anchor
            ? `Primäranker: ${JSON.stringify(params.structuredContext.primary_anchor)}`
            : null,
          "",
          "Evidenzkontext:",
          params.finalContext.slice(0, 28_000),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    response_format: zodResponseFormat(synthesisSchema, "multi_source_answer"),
  });

  const parsed = completion.choices[0]?.message?.parsed;
  const validated = synthesisSchema.parse(parsed);
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
  };
}
