import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { AI_CONFIG } from "@/lib/ai/config";
import { AIProviderError } from "@/lib/ai/errors";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import {
  KnowledgeRetriever,
  type KnowledgeHit,
} from "@/lib/knowledge/knowledgeRetriever";

const answerSchema = z.object({
  direct_answer: z.string(),
  reasoning: z.string(),
  technical_objects: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  source_ranks_used: z.array(z.number().int().positive()).default([]),
  insufficient_evidence: z.boolean(),
});

export type AnswerQuestionResult = {
  status: "ok" | "insufficient" | "error";
  question: string;
  direct_answer: string;
  reasoning: string;
  technical_objects: string[];
  uncertainties: string[];
  sources: KnowledgeHit[];
  model: string;
  token_usage: { input: number; output: number; embedding: number };
  estimated_cost: number;
  retrieval_summary: string;
  vector_search_active: boolean;
  warnings: string[];
  message?: string;
};

function estimateCost(input: number, output: number, embedding: number): number {
  const chat = AI_CONFIG.pricingUsdPer1M[AI_CONFIG.chatModel] ?? {
    input: 0.4,
    output: 1.6,
  };
  const emb = AI_CONFIG.pricingUsdPer1M[AI_CONFIG.embeddingModel] ?? {
    input: 0.02,
    output: 0,
  };
  return Number(
    (
      (input / 1_000_000) * chat.input +
      (output / 1_000_000) * chat.output +
      (embedding / 1_000_000) * emb.input
    ).toFixed(6),
  );
}

function formatSourcesForPrompt(hits: KnowledgeHit[]): string {
  return hits
    .map((h) => {
      const facts = h.facts.map((f) => `- FACT: ${f}`).join("\n");
      const inferences = h.inferences
        .map((i) => `- INFERENCE: ${i}`)
        .join("\n");
      return [
        `### Quelle #${h.rank} | ${h.title}`,
        `source_key: ${h.source_key}`,
        `type: ${h.knowledge_unit_type}`,
        `object: ${h.object_type} ${h.object_name} ${h.subobject_name}`.trim(),
        `score: ${h.combined_score.toFixed(3)}`,
        `snippet: ${h.snippet}`,
        h.technical_summary ? `technical_summary: ${h.technical_summary}` : "",
        h.business_purpose ? `business_purpose: ${h.business_purpose}` : "",
        facts,
        inferences,
        h.evidence_refs.length
          ? `evidence_refs: ${h.evidence_refs.slice(0, 8).join(" | ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

const SYSTEM_PROMPT = `Du bist ein Assistent für belegbare Antworten aus einem indexierten Wissensbestand.
Regeln (streng):
- Antworte ausschließlich aus den bereitgestellten Quellen.
- Ergänze keine allgemeinen Produkt- oder Systemkenntnisse außerhalb der Quellen.
- Erfinde keine fachliche Bedeutung.
- Unterscheide Facts und Inferences; kennzeichne Unsicherheit.
- Wenn die Quellen nicht ausreichen: insufficient_evidence=true und sage klar, dass es im aktuell indexierten Wissensbestand nicht belastbar beantwortbar ist.
- Jede Kernaussage muss sich auf mindestens eine Quellennummer (rank) stützen.
- Sprache: Deutsch.`;

export async function answerQuestion(params: {
  projectId: string;
  question: string;
  limit?: number;
}): Promise<AnswerQuestionResult> {
  const question = params.question.trim();
  if (!question) {
    return {
      status: "error",
      question,
      direct_answer: "",
      reasoning: "",
      technical_objects: [],
      uncertainties: [],
      sources: [],
      model: AI_CONFIG.chatModel,
      token_usage: { input: 0, output: 0, embedding: 0 },
      estimated_cost: 0,
      retrieval_summary: "",
      vector_search_active: false,
      warnings: [],
      message: "Bitte eine Frage eingeben.",
    };
  }

  const project = await fileProjectRepository.getById(params.projectId);
  if (!project) {
    return {
      status: "error",
      question,
      direct_answer: "",
      reasoning: "",
      technical_objects: [],
      uncertainties: [],
      sources: [],
      model: AI_CONFIG.chatModel,
      token_usage: { input: 0, output: 0, embedding: 0 },
      estimated_cost: 0,
      retrieval_summary: "",
      vector_search_active: false,
      warnings: [],
      message: "Projekt nicht konfiguriert.",
    };
  }

  let retrieval;
  try {
    retrieval = await KnowledgeRetriever.search({
      project,
      query: question,
      limit: params.limit ?? 8,
    });
  } catch (error) {
    return {
      status: "error",
      question,
      direct_answer: "",
      reasoning: "",
      technical_objects: [],
      uncertainties: [],
      sources: [],
      model: AI_CONFIG.chatModel,
      token_usage: { input: 0, output: 0, embedding: 0 },
      estimated_cost: 0,
      retrieval_summary: "",
      vector_search_active: false,
      warnings: [],
      message:
        error instanceof Error
          ? error.message
          : "Wissensbestand konnte nicht gelesen werden.",
    };
  }

  if (retrieval.hits.length === 0) {
    return {
      status: "insufficient",
      question,
      direct_answer:
        "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar.",
      reasoning: "Die Suche lieferte keine Treffer.",
      technical_objects: [],
      uncertainties: ["Keine passenden SearchDocuments gefunden."],
      sources: [],
      model: AI_CONFIG.chatModel,
      token_usage: {
        input: 0,
        output: 0,
        embedding: retrieval.query_embedding_tokens,
      },
      estimated_cost: retrieval.query_embedding_cost,
      retrieval_summary: `0/${retrieval.document_count} Treffer`,
      vector_search_active: retrieval.vector_search_active,
      warnings: retrieval.warnings,
    };
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return {
      status: "error",
      question,
      direct_answer: "",
      reasoning: "",
      technical_objects: [],
      uncertainties: [],
      sources: retrieval.hits,
      model: AI_CONFIG.chatModel,
      token_usage: {
        input: 0,
        output: 0,
        embedding: retrieval.query_embedding_tokens,
      },
      estimated_cost: retrieval.query_embedding_cost,
      retrieval_summary: `${retrieval.hits.length}/${retrieval.document_count} Treffer (ohne Antwortgenerierung)`,
      vector_search_active: retrieval.vector_search_active,
      warnings: retrieval.warnings,
      message:
        "OPENAI_API_KEY fehlt. Retrieval hat Treffer geliefert, aber keine Antwort kann erzeugt werden.",
    };
  }

  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: AI_CONFIG.timeoutMs,
      maxRetries: AI_CONFIG.maxRetries,
    });
    const userPrompt = [
      `Frage: ${question}`,
      "",
      "Quellen:",
      formatSourcesForPrompt(retrieval.hits),
    ].join("\n");

    const completion = await client.chat.completions.parse({
      model: AI_CONFIG.chatModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: zodResponseFormat(answerSchema, "rag_answer"),
      temperature: 0,
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      throw new AIProviderError({
        message: "Strukturierte Antwort fehlt.",
        category: "provider",
        retryable: true,
      });
    }

    const input = completion.usage?.prompt_tokens ?? 0;
    const output = completion.usage?.completion_tokens ?? 0;
    const embedding = retrieval.query_embedding_tokens;
    const usedRanks = new Set(parsed.source_ranks_used);
    const sources =
      usedRanks.size > 0
        ? retrieval.hits.filter((h) => usedRanks.has(h.rank))
        : retrieval.hits;

    const insufficient = parsed.insufficient_evidence || sources.length === 0;
    return {
      status: insufficient ? "insufficient" : "ok",
      question,
      direct_answer: insufficient
        ? "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar."
        : parsed.direct_answer,
      reasoning: parsed.reasoning,
      technical_objects: parsed.technical_objects,
      uncertainties: parsed.uncertainties,
      sources: insufficient ? retrieval.hits.slice(0, 3) : sources,
      model: AI_CONFIG.chatModel,
      token_usage: { input, output, embedding },
      estimated_cost: estimateCost(input, output, embedding),
      retrieval_summary: `${retrieval.hits.length} Treffer aus ${retrieval.document_count} Dokumenten`,
      vector_search_active: retrieval.vector_search_active,
      warnings: retrieval.warnings,
    };
  } catch (error) {
    const message =
      error instanceof AIProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : "OpenAI-Fehler";
    return {
      status: "error",
      question,
      direct_answer: "",
      reasoning: "",
      technical_objects: [],
      uncertainties: [],
      sources: retrieval.hits,
      model: AI_CONFIG.chatModel,
      token_usage: {
        input: 0,
        output: 0,
        embedding: retrieval.query_embedding_tokens,
      },
      estimated_cost: retrieval.query_embedding_cost,
      retrieval_summary: `${retrieval.hits.length}/${retrieval.document_count} Treffer`,
      vector_search_active: retrieval.vector_search_active,
      warnings: retrieval.warnings,
      message,
    };
  }
}
