import { PIPELINE_STEPS } from "@/lib/core/pipelineRegistry";
import type { DomainProfile, NonEmptyTuple } from "@/lib/domain/types";

/**
 * SAP domain vocabulary — owned here, not in the generic query-plan core.
 */

export const SAP_INTENTS = [
  "customer_specific_logic",
  "hardcoded_values",
  "process_behavior",
  "code_explanation",
  "table_configuration",
  "interface_behavior",
  "migration_risk",
  "dependency_analysis",
  "general_knowledge_search",
  "unknown",
] as const satisfies NonEmptyTuple;

export const SAP_ENTITY_TYPES = [
  "customer_name",
  "customer_number",
  "partner_number",
  "partner_role",
  "vendor",
  "material",
  "plant",
  "storage_location",
  "sales_org",
  "distribution_channel",
  "division",
  "table",
  "class",
  "method",
  "program",
  "function_module",
  "interface",
  "field",
  "value",
  "process",
  "unknown",
] as const satisfies NonEmptyTuple;

export const SAP_TARGET_TYPES = [
  "business_rule",
  "customer_requirement_candidate",
  "hardcoded_value",
  "customer_reference",
  "partner_reference",
  "code_unit",
  "unit_analysis",
  "code_table_interpretation",
  "table_profile",
  "table_rule_group",
  "table_row",
  "relation",
  "interface_reference",
  "unknown",
] as const satisfies NonEmptyTuple;

export const SAP_RELATION_EXPANSIONS = [
  "none",
  "callers",
  "callees",
  "table_accesses",
  "related_entities",
  "one_hop",
] as const satisfies NonEmptyTuple;

export const SAP_REQUIRED_EVIDENCE = [
  "code",
  "comment",
  "table_definition",
  "table_row",
  "hardcoding",
  "caller_relation",
  "callee_relation",
  "field_assignment",
  "interface",
  "metadata",
] as const satisfies NonEmptyTuple;

export const SAP_METADATA_FIELDS = [
  "unit_type",
  "include_name",
  "language",
  "classification",
  "primary_key",
  "business_rule_id",
  "likely_table_role",
  "code_source_key",
  "access_id",
] as const;

export const SAP_KNOWLEDGE_UNIT_TYPES = [
  "code_unit",
  "control_table",
  "control_table_row",
  "code_table_interpretation",
  "dynamic_table_access",
  "business_rule",
] as const;

export const SAP_DOMAIN_PROFILE: DomainProfile = {
  id: "sap",
  version: "1.0.0",
  label: "SAP",
  description:
    "Code (ABAP), Steuertabellen und Relationen aus SAP-Landschaften.",
  intents: SAP_INTENTS,
  entityTypes: SAP_ENTITY_TYPES,
  targetTypes: SAP_TARGET_TYPES,
  relationExpansions: SAP_RELATION_EXPANSIONS,
  requiredEvidenceTypes: SAP_REQUIRED_EVIDENCE,
  knowledgeUnitTypes: SAP_KNOWLEDGE_UNIT_TYPES,
  targetTypeToKnowledgeUnitType: {
    business_rule: ["business_rule"],
    table_rule_group: ["business_rule"],
    code_unit: ["code_unit"],
    unit_analysis: ["code_unit"],
    hardcoded_value: ["code_unit"],
    customer_reference: ["code_unit"],
    partner_reference: ["code_unit"],
    customer_requirement_candidate: ["code_unit"],
    code_table_interpretation: ["code_table_interpretation"],
    table_profile: ["control_table"],
    table_row: ["control_table_row"],
    interface_reference: ["dynamic_table_access"],
  },
  defaultAdapterIds: PIPELINE_STEPS.filter((s) => s.adapter === "sap").map(
    (s) => s.id,
  ),
  searchProfile: {
    id: "search.sap.v1",
    version: "1.0.0",
    domain_profile_id: "sap",
    knowledgeUnitTypeBoosts: {
      business_rule: 0.15,
      control_table_row: 0.1,
      code_unit: 0.05,
    },
    metadataFields: SAP_METADATA_FIELDS,
    defaultRelationExpansion: true,
  },
  plannerPromptKey: "query_planner.sap",
  plannerPromptVersion: "v1",
  answerPromptKey: "answer_synthesizer.sap",
  answerPromptVersion: "v1",
  plannerPromptExtension:
    "Domäne: SAP (ABAP-Code, Steuertabellen, Kunden-/Partner-Sonderlogik). " +
    "Entitäten wie Kundennummer, Partnerrolle, Material, Werk sind SAP-Stammdaten-Begriffe.",
  answerPromptExtension:
    "Domäne: SAP. Quellen sind Code-Units (Klasse/Methode), Steuertabellenzeilen " +
    "und deren Verknüpfungen. Kundenspezifische Sonderlogik ist häufig an " +
    "Kunden-/Partnernummern in Tabellen oder Hardcodings im Code gebunden.",
  answerLabels: {
    specialProcessLabel: "Erkannte Besonderheit",
    triggerLabel: "Auslöser",
    effectLabel: "Systemwirkung",
    technicalSourceLabel: "Klasse / Methode",
  },
  workflowTemplateId: "sap_knowledge_reconstruction.v1",
};
