/**
 * Domain Profile — separates generic core RAG/query-plan logic from
 * domain-specific vocabulary (SAP, website, database, ...).
 */

export const DOMAIN_PROFILE_IDS = [
  "sap",
  "website",
  "database",
  "sharepoint",
  "generic_documents",
] as const;

export type DomainProfileId = (typeof DOMAIN_PROFILE_IDS)[number];

export type NonEmptyTuple = readonly [string, ...string[]];

export type DomainSearchProfile = {
  id: string;
  version: string;
  domain_profile_id: DomainProfileId;
  /** Relative weight bumps for domain-relevant knowledge_unit_types (additive). */
  knowledgeUnitTypeBoosts: Record<string, number>;
  /** Metadata fields this domain exposes for query-plan filters. */
  metadataFields: readonly string[];
  /** Enables relation-graph (caller/callee/table) expansion by default. */
  defaultRelationExpansion: boolean;
};

export type DomainAnswerLabels = {
  specialProcessLabel: string;
  triggerLabel: string;
  effectLabel: string;
  technicalSourceLabel: string;
};

export type DomainProfile = {
  id: DomainProfileId;
  version: string;
  label: string;
  description: string;
  intents: NonEmptyTuple;
  entityTypes: NonEmptyTuple;
  targetTypes: NonEmptyTuple;
  relationExpansions: NonEmptyTuple;
  requiredEvidenceTypes: NonEmptyTuple;
  knowledgeUnitTypes: readonly string[];
  targetTypeToKnowledgeUnitType: Record<string, string[] | undefined>;
  defaultAdapterIds: readonly string[];
  searchProfile: DomainSearchProfile;
  /** PromptRegistry prompt_id for planner domain extension. */
  plannerPromptKey: string;
  plannerPromptVersion: string;
  /** PromptRegistry prompt_id for answer domain extension. */
  answerPromptKey: string;
  answerPromptVersion: string;
  /** Appended to the generic query-planner system prompt. */
  plannerPromptExtension: string;
  /** Appended to the generic answer-synthesizer system prompt. */
  answerPromptExtension: string;
  answerLabels: DomainAnswerLabels;
  /** Versioned workflow template id (e.g. SAP Fahrplan). */
  workflowTemplateId?: string;
};
