import { z } from "zod";

/** Internal evidence strength — only confirmed is a safe fact in answers. */
export const evidenceLevelSchema = z.enum([
  "confirmed",
  "inferred",
  "possible",
  "not_supported",
  "contradicted",
]);

export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

export const classifiedStatementSchema = z.object({
  text: z.string(),
  level: evidenceLevelSchema,
  /** Source ranks (#N from evidence context) backing this claim. */
  source_ranks: z.array(z.number().int().positive()).default([]),
  /** Optional source_key refs for UI assignment. */
  source_ids: z.array(z.string()).default([]),
});

export type ClassifiedStatement = z.infer<typeof classifiedStatementSchema>;

/**
 * Prozessantwort — fachliche Nutzer.
 * Legacy narrative fields remain for compatibility; classified sections are canonical.
 */
export const processAnswerSchema = z.object({
  direct_answer: z.string().default(""),
  special_process: z.string().default(""),
  trigger: z.string().default(""),
  process_effect: z.string().default(""),
  business_interpretation: z.string().default(""),
  open_validation_questions: z.array(z.string()).default([]),
  /** Sicher belegt (green). */
  confirmed: z.array(classifiedStatementSchema).default([]),
  /** Wahrscheinlich / abgeleitet (yellow). */
  inferred: z.array(classifiedStatementSchema).default([]),
  /** Offen / nicht belegt (neutral). */
  open: z.array(classifiedStatementSchema).default([]),
  has_safe_process_claim: z.boolean().default(false),
  no_process_claim_message: z.string().default(""),
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

/** Compact substantial technical answer with evidence levels. */
export const technicalAnswerSchema = z.object({
  entry_point: z.array(classifiedStatementSchema).default([]),
  trigger: z.array(classifiedStatementSchema).default([]),
  processing: z.array(classifiedStatementSchema).default([]),
  objects: z.array(classifiedStatementSchema).default([]),
  results: z.array(classifiedStatementSchema).default([]),
  relations: z.array(classifiedStatementSchema).default([]),
  open: z.array(classifiedStatementSchema).default([]),
});

export type TechnicalAnswer = z.infer<typeof technicalAnswerSchema>;

export const structuredAnswerSchema = z.object({
  process_answer: processAnswerSchema,
  technical_details: technicalDetailsSchema,
  technical_answer: technicalAnswerSchema,
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
  confirmed: [],
  inferred: [],
  open: [],
  has_safe_process_claim: false,
  no_process_claim_message: "",
};

export const EMPTY_TECHNICAL_ANSWER: TechnicalAnswer = {
  entry_point: [],
  trigger: [],
  processing: [],
  objects: [],
  results: [],
  relations: [],
  open: [],
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

/** LLM statement — ranks required for confirmed; inferred may omit. */
const llmStatementSchema = z.object({
  text: z.string(),
  level: z.enum(["confirmed", "inferred", "possible"]).default("inferred"),
  source_ranks: z.array(z.number().int().positive()).default([]),
});

/**
 * LLM-facing answer contract.
 * Server merges lists / demotes unverifiable confirmed claims.
 */
export const llmAnswerSchema = z.object({
  process_answer: z.object({
    summary: z.string().default(""),
    statements: z.array(llmStatementSchema).default([]),
    open_items: z.array(z.string()).default([]),
    has_safe_process_claim: z.boolean().default(false),
  }),
  technical_answer: z.object({
    entry_point: z.array(llmStatementSchema).default([]),
    trigger: z.array(llmStatementSchema).default([]),
    processing: z.array(llmStatementSchema).default([]),
    objects: z.array(llmStatementSchema).default([]),
    results: z.array(llmStatementSchema).default([]),
    relations: z.array(llmStatementSchema).default([]),
    open: z.array(llmStatementSchema).default([]),
  }),
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
