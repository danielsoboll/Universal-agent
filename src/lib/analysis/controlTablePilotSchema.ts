import { z } from "zod";

export const CONTROL_TABLE_ANALYSIS_PROMPT_VERSION = "control-table-analysis-v1";
export const CODE_TABLE_INTERPRETATION_PROMPT_VERSION =
  "code-table-interpretation-v1";

export const evidencedTextSchema = z.object({
  text: z.string(),
  evidence: z.array(z.string()).default([]),
});

/** Model output for one control table (pilot). */
export const controlTableAnalysisModelSchema = z.object({
  technical_purpose: z.string(),
  business_purpose_inferred: z.string(),
  likely_table_role: z.string(),
  key_semantics: z.array(z.string()).default([]),
  value_semantics: z.array(z.string()).default([]),
  parameters: z.array(z.string()).default([]),
  mappings: z.array(z.string()).default([]),
  status_codes: z.array(z.string()).default([]),
  system_references: z.array(z.string()).default([]),
  special_cases: z.array(z.string()).default([]),
  facts: z.array(evidencedTextSchema).default([]),
  inferences: z.array(evidencedTextSchema).default([]),
  risks: z.array(z.string()).default([]),
  unresolved_points: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export type ControlTableAnalysisModel = z.infer<
  typeof controlTableAnalysisModelSchema
>;

export const controlTableAnalysisRecordSchema =
  controlTableAnalysisModelSchema.extend({
    source_key: z.string(),
    table_name: z.string(),
    selection_reason: z.string(),
    model: z.string(),
    prompt_version: z.string(),
    content_hash: z.string(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    estimated_cost: z.number().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
  });

export type ControlTableAnalysisRecord = z.infer<
  typeof controlTableAnalysisRecordSchema
>;

/** Model output — resolved_key/values come from canonical row, not the model. */
export const codeTableInterpretationModelSchema = z.object({
  matched_conditions: z.array(z.string()).default([]),
  code_usage_after_read: z.array(z.string()).default([]),
  technical_interpretation: z.string(),
  business_rule_inferred: z.string(),
  facts: z.array(evidencedTextSchema).default([]),
  inferences: z.array(evidencedTextSchema).default([]),
  evidence_from_code: z.array(z.string()).default([]),
  evidence_from_table: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  unresolved_points: z.array(z.string()).default([]),
});

export type CodeTableInterpretationModel = z.infer<
  typeof codeTableInterpretationModelSchema
>;

export const codeTableInterpretationRecordSchema =
  codeTableInterpretationModelSchema.extend({
    source_key: z.string(),
    code_source_key: z.string(),
    class_name: z.string(),
    method_name: z.string(),
    table_name: z.string(),
    table_row_source_key: z.string(),
    resolved_key: z.string(),
    resolved_values: z.record(z.string(), z.string()).default({}),
    /** Einzelner technischer Tabellenzugriff (nicht zusammengeführt). */
    access_id: z.string(),
    /** Gruppierung logisch gleicher Geschäftsregel über mehrere Zugriffe. */
    business_rule_id: z.string(),
    model: z.string(),
    prompt_version: z.string(),
    content_hash: z.string(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    estimated_cost: z.number().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
  });

export type CodeTableInterpretationRecord = z.infer<
  typeof codeTableInterpretationRecordSchema
>;

export const analysisDeviationSchema = z.object({
  at: z.string(),
  scope: z.enum(["table_analysis", "code_table_interpretation"]),
  source_key: z.string(),
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type AnalysisDeviation = z.infer<typeof analysisDeviationSchema>;
