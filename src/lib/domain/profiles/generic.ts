import type {
  DomainAnswerLabels,
  DomainProfile,
  DomainProfileId,
  NonEmptyTuple,
} from "@/lib/domain/types";

/**
 * Non-SAP domains: universal vocabulary only — no partner roles, ABAP classes,
 * customer numbers, or SAP table concepts.
 */

const GENERIC_INTENTS = [
  "fact_lookup",
  "process_behavior",
  "content_explanation",
  "configuration",
  "dependency_analysis",
  "general_knowledge_search",
  "unknown",
] as const satisfies NonEmptyTuple;

const GENERIC_ENTITY_TYPES = [
  "topic",
  "identifier",
  "field",
  "value",
  "process",
  "unknown",
] as const satisfies NonEmptyTuple;

const GENERIC_TARGET_TYPES = [
  "business_rule",
  "reference",
  "content_unit",
  "relation",
  "unknown",
] as const satisfies NonEmptyTuple;

const GENERIC_RELATION_EXPANSIONS = [
  "none",
  "related_entities",
  "one_hop",
] as const satisfies NonEmptyTuple;

const GENERIC_REQUIRED_EVIDENCE = [
  "content",
  "metadata",
  "reference",
] as const satisfies NonEmptyTuple;

const GENERIC_METADATA_FIELDS = [
  "unit_type",
  "include_name",
  "language",
  "classification",
] as const;

function buildGenericDomainProfile(params: {
  id: DomainProfileId;
  label: string;
  description: string;
  knowledgeUnitTypes: readonly string[];
  answerLabels: DomainAnswerLabels;
  plannerPromptKey: string;
  answerPromptKey: string;
  plannerPromptExtension: string;
  answerPromptExtension: string;
  workflowTemplateId?: string;
}): DomainProfile {
  return {
    id: params.id,
    version: "1.0.0",
    label: params.label,
    description: params.description,
    intents: GENERIC_INTENTS,
    entityTypes: GENERIC_ENTITY_TYPES,
    targetTypes: GENERIC_TARGET_TYPES,
    relationExpansions: GENERIC_RELATION_EXPANSIONS,
    requiredEvidenceTypes: GENERIC_REQUIRED_EVIDENCE,
    knowledgeUnitTypes: params.knowledgeUnitTypes,
    targetTypeToKnowledgeUnitType: {
      business_rule: ["business_rule"],
      reference: [...params.knowledgeUnitTypes.slice(0, 1)],
      content_unit: [...params.knowledgeUnitTypes.slice(0, 1)],
    },
    defaultAdapterIds: [],
    searchProfile: {
      id: `search.${params.id}.v1`,
      version: "1.0.0",
      domain_profile_id: params.id,
      knowledgeUnitTypeBoosts: {},
      metadataFields: GENERIC_METADATA_FIELDS,
      defaultRelationExpansion: false,
    },
    plannerPromptKey: params.plannerPromptKey,
    plannerPromptVersion: "v1",
    answerPromptKey: params.answerPromptKey,
    answerPromptVersion: "v1",
    plannerPromptExtension: params.plannerPromptExtension,
    answerPromptExtension: params.answerPromptExtension,
    answerLabels: params.answerLabels,
    workflowTemplateId: params.workflowTemplateId,
  };
}

export const WEBSITE_DOMAIN_PROFILE = buildGenericDomainProfile({
  id: "website",
  label: "Homepage",
  description: "Webseiteninhalte und Struktur.",
  knowledgeUnitTypes: ["web_page", "web_content_block"],
  plannerPromptKey: "query_planner.website",
  answerPromptKey: "answer_synthesizer.website",
  plannerPromptExtension:
    "Domäne: Webseite. Entitäten sind Themen, Seiten und Inhalte.",
  answerPromptExtension:
    "Domäne: Webseite. Quellen sind Seiten-/Inhaltsauszüge.",
  answerLabels: {
    specialProcessLabel: "Erkannte Besonderheit",
    triggerLabel: "Bedingung",
    effectLabel: "Wirkung",
    technicalSourceLabel: "Seite / Abschnitt",
  },
  workflowTemplateId: "website_content_index.v1",
});

export const DATABASE_DOMAIN_PROFILE = buildGenericDomainProfile({
  id: "database",
  label: "Datenbank",
  description: "Datenmodelle, Tabellen und Datenbestände.",
  knowledgeUnitTypes: ["db_table", "db_row", "db_relation"],
  plannerPromptKey: "query_planner.database",
  answerPromptKey: "answer_synthesizer.database",
  plannerPromptExtension:
    "Domäne: Datenbank. Entitäten sind Tabellen, Spalten und Datensätze.",
  answerPromptExtension:
    "Domäne: Datenbank. Quellen sind Tabellen-/Datensatzauszüge.",
  answerLabels: {
    specialProcessLabel: "Erkannte Besonderheit",
    triggerLabel: "Bedingung",
    effectLabel: "Wirkung",
    technicalSourceLabel: "Tabelle / Spalte",
  },
  workflowTemplateId: "database_schema_index.v1",
});

export const SHAREPOINT_DOMAIN_PROFILE = buildGenericDomainProfile({
  id: "sharepoint",
  label: "SharePoint",
  description: "Dokumente und Listen aus SharePoint.",
  knowledgeUnitTypes: ["sp_document", "sp_list_item"],
  plannerPromptKey: "query_planner.sharepoint",
  answerPromptKey: "answer_synthesizer.sharepoint",
  plannerPromptExtension:
    "Domäne: SharePoint. Entitäten sind Dokumente, Listen und Metadaten.",
  answerPromptExtension:
    "Domäne: SharePoint. Quellen sind Dokument-/Listenauszüge.",
  answerLabels: {
    specialProcessLabel: "Erkannte Besonderheit",
    triggerLabel: "Bedingung",
    effectLabel: "Wirkung",
    technicalSourceLabel: "Dokument / Liste",
  },
  workflowTemplateId: "sharepoint_document_index.v1",
});

export const GENERIC_DOCUMENTS_DOMAIN_PROFILE = buildGenericDomainProfile({
  id: "generic_documents",
  label: "Allgemeine Dokumente",
  description: "Beliebige importierte Dokumente ohne spezialisierte Domäne.",
  knowledgeUnitTypes: ["document_chunk"],
  plannerPromptKey: "query_planner.generic_documents",
  answerPromptKey: "answer_synthesizer.generic_documents",
  plannerPromptExtension:
    "Domäne: Allgemeine Dokumente. Keine domänenspezifischen Entitätstypen — bleib generisch.",
  answerPromptExtension:
    "Domäne: Allgemeine Dokumente. Quellen sind generische Dokumentauszüge.",
  answerLabels: {
    specialProcessLabel: "Erkannte Besonderheit",
    triggerLabel: "Bedingung",
    effectLabel: "Wirkung",
    technicalSourceLabel: "Dokument",
  },
});
