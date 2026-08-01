import { z } from "zod";

/** Structured RAG answer: process narrative + technical evidence. */
export const processAnswerSchema = z.object({
  direct_answer: z.string().default(""),
  special_process: z.string().default(""),
  trigger: z.string().default(""),
  process_effect: z.string().default(""),
  business_interpretation: z.string().default(""),
  open_validation_questions: z.array(z.string()).default([]),
});

export const technicalSourceSchema = z.object({
  object_kind: z.string().default(""),
  class_or_program: z.string().default(""),
  method_or_routine: z.string().default(""),
  source_key: z.string().default(""),
  title: z.string().default(""),
  knowledge_unit_type: z.string().default(""),
  rank: z.number().int().positive().optional(),
  score: z.number().optional(),
});

export const technicalDetailsSchema = z.object({
  sources: z.array(technicalSourceSchema).default([]),
  callers: z.array(z.string()).default([]),
  called_objects: z.array(z.string()).default([]),
  conditions: z.array(z.string()).default([]),
  table_accesses: z.array(z.string()).default([]),
  hardcoded_values: z.array(z.string()).default([]),
  changed_fields: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  facts: z.array(z.string()).default([]),
  inferences: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).nullable().default(null),
  retrieval_mode: z.string().optional(),
  retrieval_scores: z
    .array(
      z.object({
        rank: z.number(),
        title: z.string(),
        combined: z.number(),
        exact: z.number().optional(),
        fulltext: z.number().optional(),
        vector: z.number().optional(),
      }),
    )
    .default([]),
});

export const structuredAnswerSchema = z.object({
  process_answer: processAnswerSchema,
  technical_details: technicalDetailsSchema,
  source_ranks_used: z.array(z.number().int().positive()).default([]),
  insufficient_evidence: z.boolean(),
});

export type ProcessAnswer = z.infer<typeof processAnswerSchema>;
export type TechnicalDetails = z.infer<typeof technicalDetailsSchema>;
export type StructuredAnswer = z.infer<typeof structuredAnswerSchema>;

/**
 * Compact technical-details schema (max 5 sections). Deterministically
 * derived from retrieval hits + entity grounding — explains only the
 * concrete rule that was actually found, not a dump of everything retrieved.
 */
export const compactTechnicalDetailsSchema = z.object({
  quelle: z.array(z.string()).default([]),
  ausloeser: z.array(z.string()).default([]),
  systemaktion: z.array(z.string()).default([]),
  beleg: z.array(z.string()).default([]),
  unsicherheit: z.array(z.string()).default([]),
  /** Hardcodings whose semantic role could not be determined — raw view only. */
  hidden_hardcodings: z.array(z.string()).default([]),
});

export type CompactTechnicalDetails = z.infer<typeof compactTechnicalDetailsSchema>;

export const EMPTY_COMPACT_TECHNICAL_DETAILS: CompactTechnicalDetails = {
  quelle: [],
  ausloeser: [],
  systemaktion: [],
  beleg: [],
  unsicherheit: [],
  hidden_hardcodings: [],
};

export const EMPTY_PROCESS_ANSWER: ProcessAnswer = {
  direct_answer: "",
  special_process: "",
  trigger: "",
  process_effect: "",
  business_interpretation: "",
  open_validation_questions: [],
};

export const EMPTY_TECHNICAL_DETAILS: TechnicalDetails = {
  sources: [],
  callers: [],
  called_objects: [],
  conditions: [],
  table_accesses: [],
  hardcoded_values: [],
  changed_fields: [],
  evidence: [],
  facts: [],
  inferences: [],
  confidence: null,
  retrieval_scores: [],
};

/** LLM-facing subset: narrative fields only; lists are merged from sources. */
export const llmAnswerSchema = z.object({
  process_answer: processAnswerSchema,
  technical_details: z.object({
    conditions: z.array(z.string()).default([]),
    changed_fields: z.array(z.string()).default([]),
    /** Only include items explicitly present in the provided sources. */
    additional_evidence_notes: z.array(z.string()).default([]),
  }),
  source_ranks_used: z.array(z.number().int().positive()).default([]),
  insufficient_evidence: z.boolean(),
});

export type LlmAnswerPayload = z.infer<typeof llmAnswerSchema>;
