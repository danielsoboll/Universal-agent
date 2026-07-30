import { z } from "zod";

/** Bump when prompt or schema semantics change — triggers re-analysis. */
export const UNIT_ANALYSIS_PROMPT_VERSION = "unit-analysis-v4";

export const evidenceLineSchema = z.object({
  line: z.number().int().positive(),
  /** Model may return ""; repair/validation rejects empty quotes. */
  quote: z.string(),
});

/** Fact or inference; evidence enforced after deterministic repair. */
export const evidencedStatementSchema = z.object({
  text: z.string().min(1),
  evidence_lines: z.array(evidenceLineSchema),
});

export const externalInterfaceKindSchema = z.enum([
  "sap_proxy_or_webservice",
  "rfc_destination",
  "http_or_rest",
  "file_interface",
  "idoc",
  "function_module",
  "external_system_name",
  "internal_method_or_variable",
]);

/**
 * Model-produced fields only (identity/metadata attached by the runner).
 * Macros must NOT appear in called_methods — use macro_calls (runner-filled).
 */
export const unitAnalysisModelSchema = z.object({
  technical_summary: z.string(),
  business_purpose_inferred: z.string(),
  facts: z.array(evidencedStatementSchema),
  inferences: z.array(evidencedStatementSchema),
  open_questions: z.array(z.string()),
  tables_read: z.array(z.string()),
  tables_written: z.array(z.string()),
  called_functions: z.array(z.string()),
  called_methods: z.array(z.string()),
  hardcoded_values: z.array(z.string()),
  special_cases: z.array(z.string()),
  external_interfaces: z.array(z.string()),
  risks: z.array(z.string()),
  evidence_lines: z.array(evidenceLineSchema),
  confidence: z.number().min(0).max(1),
});

export type UnitAnalysisModelOutput = z.infer<typeof unitAnalysisModelSchema>;

export const methodCallRefSchema = z.object({
  raw: z.string(),
  receiver: z.string().nullable(),
  method: z.string(),
  normalized_method_name: z.string(),
});

export type MethodCallRef = z.infer<typeof methodCallRefSchema>;

export const deterministicExtractionSchema = z.object({
  tables_read: z.array(z.string()),
  tables_written: z.array(z.string()),
  called_functions: z.array(z.string()),
  called_methods: z.array(z.string()),
  called_method_refs: z.array(methodCallRefSchema).default([]),
  macro_calls: z
    .array(
      z.object({
        name: z.string(),
        line: z.number().int().positive().optional(),
        unresolved_macro: z.boolean(),
      }),
    )
    .default([]),
});

export type DeterministicExtraction = z.infer<
  typeof deterministicExtractionSchema
>;

export const extractionDeviationSchema = z.object({
  field: z.enum([
    "tables_read",
    "tables_written",
    "called_functions",
    "called_methods",
  ]),
  only_in_ai: z.array(z.string()),
  only_in_deterministic: z.array(z.string()),
});

export type ExtractionDeviation = z.infer<typeof extractionDeviationSchema>;

export const classifiedInterfaceSchema = z.object({
  kind: externalInterfaceKindSchema,
  name: z.string(),
  raw: z.string(),
});

export const macroCallSchema = z.object({
  name: z.string().min(1),
  line: z.number().int().positive().optional(),
  unresolved_macro: z.boolean(),
});

export type MacroCall = z.infer<typeof macroCallSchema>;

export const analysisRelationSchema = z.object({
  relation_type: z.literal("CALLS_MACRO"),
  from_type: z.literal("METHOD"),
  from_name: z.string(),
  to_type: z.literal("MACRO"),
  to_name: z.string(),
});

export type AnalysisRelation = z.infer<typeof analysisRelationSchema>;

export const fieldProvenanceSchema = z.object({
  field: z.enum(["called_methods", "tables_read", "tables_written", "called_functions"]),
  value: z.string(),
  source_type: z.enum(["ai", "deterministic_extraction"]),
});

export const unitAnalysisRecordSchema = unitAnalysisModelSchema.extend({
  source_key: z.string().min(1),
  class_name: z.string().min(1),
  method_name: z.string().min(1),
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  content_hash: z.string().min(1),
  deterministic: deterministicExtractionSchema,
  extraction_deviations: z.array(extractionDeviationSchema),
  external_interfaces_classified: z.array(classifiedInterfaceSchema).default([]),
  discarded_interfaces: z.array(classifiedInterfaceSchema).default([]),
  macro_calls: z.array(macroCallSchema).default([]),
  relations: z.array(analysisRelationSchema).default([]),
  search_text: z.string().default(""),
  field_provenance: z.array(fieldProvenanceSchema).default([]),
  needs_reanalysis: z.boolean().optional(),
  repair_notes: z.array(z.string()).optional(),
});

export type UnitAnalysisRecord = z.infer<typeof unitAnalysisRecordSchema>;

export const unitAnalysisErrorSchema = z.object({
  at: z.string(),
  source_key: z.string(),
  class_name: z.string().optional(),
  method_name: z.string().optional(),
  content_hash: z.string().optional(),
  prompt_version: z.string(),
  model: z.string().optional(),
  error: z.string(),
  category: z.string().optional(),
});

export type UnitAnalysisErrorRecord = z.infer<typeof unitAnalysisErrorSchema>;
