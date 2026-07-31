"use server";

import { answerQuestion } from "@/lib/knowledge/answerQuestion";
import { fileHistoryRepository } from "@/lib/localAuth/historyRepository";
import {
  primaryProjectId,
  requireLocalAppAccess,
} from "@/lib/localAuth/session";
import type { KnowledgeHit } from "@/lib/knowledge/types";

export type AskUiResult = {
  status: "ok" | "insufficient" | "error";
  message?: string;
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
};

export async function askQuestionAction(input: {
  question: string;
  projectId?: string | null;
}): Promise<AskUiResult> {
  const ctx = await requireLocalAppAccess();
  const projectId =
    input.projectId?.trim() || primaryProjectId(ctx.user) || null;
  if (!projectId) {
    return {
      status: "error",
      message: "Kein Projekt zugeordnet.",
      direct_answer: "",
      reasoning: "",
      technical_objects: [],
      uncertainties: [],
      sources: [],
      model: "",
      token_usage: { input: 0, output: 0, embedding: 0 },
      estimated_cost: 0,
      retrieval_summary: "",
      vector_search_active: false,
      warnings: [],
    };
  }
  if (!ctx.user.project_ids.includes(projectId) && ctx.user.role !== "admin") {
    return {
      status: "error",
      message: "Kein Zugriff auf dieses Projekt.",
      direct_answer: "",
      reasoning: "",
      technical_objects: [],
      uncertainties: [],
      sources: [],
      model: "",
      token_usage: { input: 0, output: 0, embedding: 0 },
      estimated_cost: 0,
      retrieval_summary: "",
      vector_search_active: false,
      warnings: [],
    };
  }

  const result = await answerQuestion({
    projectId,
    question: input.question,
  });

  if (result.status === "ok" || result.status === "insufficient") {
    await fileHistoryRepository.add({
      user_id: ctx.user.id,
      project_id: projectId,
      question: result.question,
      answer: [
        result.direct_answer,
        result.reasoning ? `\nBegründung: ${result.reasoning}` : "",
      ].join(""),
      retrieval_summary: result.retrieval_summary,
      source_refs: result.sources.map((s) => ({
        rank: s.rank,
        source_key: s.source_key,
        title: s.title,
        knowledge_unit_type: s.knowledge_unit_type,
        score: s.combined_score,
      })),
      model: result.model,
      token_usage: result.token_usage,
      estimated_cost: result.estimated_cost,
    });
  }

  return {
    status: result.status,
    message: result.message,
    direct_answer: result.direct_answer,
    reasoning: result.reasoning,
    technical_objects: result.technical_objects,
    uncertainties: result.uncertainties,
    sources: result.sources,
    model: result.model,
    token_usage: result.token_usage,
    estimated_cost: result.estimated_cost,
    retrieval_summary: result.retrieval_summary,
    vector_search_active: result.vector_search_active,
    warnings: result.warnings,
  };
}
