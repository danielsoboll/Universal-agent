import { z } from "zod";
import type { DomainProfile, NonEmptyTuple } from "@/lib/domain/types";

export const QUERY_PLAN_SCHEMA_VERSION = "query-plan-v1" as const;

export type SearchMode =
  | "direct_rag"
  | "planned_rag"
  | "full_analysis"
  | "deep_search";

/** Soft query-plan shape — allowed enums come from the active DomainProfile. */
export type QueryPlanEntity = {
  type: string;
  value: string;
  normalized_value: string;
  confidence: number;
};

export type QueryPlanSubquery = {
  id: string;
  query: string;
  purpose: string;
  target_types: string[];
  metadata_filters: Record<string, string | null>;
  relation_expansion: string;
};

export type QueryPlan = {
  schema_version: typeof QUERY_PLAN_SCHEMA_VERSION;
  original_question: string;
  normalized_question: string;
  intent: string;
  answer_scope: string;
  entities: QueryPlanEntity[];
  search_concepts: string[];
  subqueries: QueryPlanSubquery[];
  required_evidence: string[];
  ambiguities: string[];
  planner_confidence: number;
};

function asEnumTuple(values: NonEmptyTuple | readonly string[]): [string, ...string[]] {
  if (!values.length) return ["unknown"];
  return values as [string, ...string[]];
}

/**
 * Build a Zod schema whose enums are taken from the active DomainProfile.
 * Used for OpenAI structured outputs + server-side validation.
 */
export function buildQueryPlanSchema(profile: DomainProfile) {
  const intents = asEnumTuple(profile.intents);
  const entityTypes = asEnumTuple(profile.entityTypes);
  const targetTypes = asEnumTuple(profile.targetTypes);
  const relationExpansions = asEnumTuple(profile.relationExpansions);
  const requiredEvidence = asEnumTuple(profile.requiredEvidenceTypes);
  const metadataFields = [...profile.searchProfile.metadataFields];

  const metadataFiltersSchema = z.object(
    Object.fromEntries(
      metadataFields.map((field) => [field, z.string().nullable().default(null)]),
    ) as Record<string, z.ZodDefault<z.ZodNullable<z.ZodString>>>,
  );

  const defaultMeta = Object.fromEntries(
    metadataFields.map((field) => [field, null]),
  ) as Record<string, null>;

  const entitySchema = z.object({
    type: z.enum(entityTypes),
    value: z.string(),
    normalized_value: z.string().default(""),
    confidence: z.number().min(0).max(1).default(0),
  });

  const subquerySchema = z.object({
    id: z.string().min(1),
    query: z.string().min(1),
    purpose: z.string().default(""),
    target_types: z.array(z.enum(targetTypes)).default([]),
    metadata_filters: metadataFiltersSchema.default(defaultMeta),
    relation_expansion: z.enum(relationExpansions).default("none"),
  });

  return z.object({
    schema_version: z.literal(QUERY_PLAN_SCHEMA_VERSION),
    original_question: z.string(),
    normalized_question: z.string().default(""),
    intent: z.enum(intents),
    answer_scope: z.string().default("process_and_technical"),
    entities: z.array(entitySchema).default([]),
    search_concepts: z.array(z.string()).default([]),
    subqueries: z.array(subquerySchema).min(1).max(6),
    required_evidence: z.array(z.enum(requiredEvidence)).default([]),
    ambiguities: z.array(z.string()).default([]),
    planner_confidence: z.number().min(0).max(1).default(0),
  });
}

export type QueryPlanZodSchema = ReturnType<typeof buildQueryPlanSchema>;

/**
 * Map planner target_types → SearchDocument.knowledge_unit_type via DomainProfile.
 */
export function mapTargetTypesToKnowledgeUnitTypes(
  targetTypes: string[],
  mapping: Record<string, string[] | undefined>,
): string[] | undefined {
  if (!targetTypes.length) return undefined;
  const mapped = new Set<string>();
  for (const t of targetTypes) {
    const ku = mapping[t];
    if (!ku) continue;
    for (const k of ku) mapped.add(k);
  }
  if (mapped.size === 0) return undefined;
  return [...mapped];
}

export function sanitizeMetadataFilters(
  filters: Record<string, unknown> | undefined,
  allowedFields: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(allowedFields);
  const out: Record<string, unknown> = {};
  if (!filters) return out;
  for (const [k, v] of Object.entries(filters)) {
    if (!allowed.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}
