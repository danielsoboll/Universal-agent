import { z } from "zod";

/** Bump when SearchDocument semantics or search_text layout change. */
export const SEARCH_DOCUMENT_VERSION = "search-document-v1";

export const searchEntitySchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  /** Optional normalized form for matching; original stays in `name`. */
  normalized: z.string().optional(),
});

export type SearchEntity = z.infer<typeof searchEntitySchema>;

export const searchRelationSchema = z.object({
  relation_type: z.string().min(1),
  from_type: z.string().optional(),
  from_name: z.string().optional(),
  to_type: z.string().optional(),
  to_name: z.string().optional(),
});

export type SearchRelation = z.infer<typeof searchRelationSchema>;

export const searchEvidenceLineSchema = z.object({
  line: z.number().int().positive().optional(),
  quote: z.string().optional(),
});

export const searchEvidenceSchema = z.object({
  statement_type: z.enum(["fact", "inference", "general"]),
  text: z.string().optional(),
  lines: z.array(searchEvidenceLineSchema).default([]),
});

export type SearchEvidence = z.infer<typeof searchEvidenceSchema>;

/**
 * Quellenunabhängiges Suchdokument.
 * Erste konkrete Quelle: Code-Unit-Analysen; Schema bleibt generisch.
 */
export const searchDocumentSchema = z.object({
  search_document_id: z.string().min(1),
  source_system: z.string().min(1),
  source_type: z.string().min(1),
  source_key: z.string().min(1),
  knowledge_unit_type: z.string().min(1),
  object_type: z.string().default(""),
  object_name: z.string().default(""),
  subobject_name: z.string().default(""),
  title: z.string().min(1),
  technical_summary: z.string().default(""),
  business_purpose: z.string().default(""),
  facts: z.array(z.string()).default([]),
  inferences: z.array(z.string()).default([]),
  entities: z.array(searchEntitySchema).default([]),
  relations: z.array(searchRelationSchema).default([]),
  tables_read: z.array(z.string()).default([]),
  tables_written: z.array(z.string()).default([]),
  called_methods: z.array(z.string()).default([]),
  called_functions: z.array(z.string()).default([]),
  macro_calls: z.array(z.string()).default([]),
  hardcoded_values: z.array(z.string()).default([]),
  external_interfaces: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  evidence: z.array(searchEvidenceSchema).default([]),
  confidence: z.number().min(0).max(1).nullable().default(null),
  content_hash: z.string().min(1),
  analysis_version: z.string().default(""),
  search_text: z.string().default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type SearchDocument = z.infer<typeof searchDocumentSchema>;

/**
 * Canonical content payload for hashing (excludes id/timestamps/search_text).
 * search_text is derived; hashing structured fields keeps skips stable.
 */
export type SearchDocumentContentPayload = Omit<
  SearchDocument,
  "search_document_id" | "search_text" | "content_hash" | "created_at" | "updated_at"
>;
