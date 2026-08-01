import { createHash } from "crypto";
import type { WorkflowProcessDefinition } from "@/lib/workflow/types";
import { extractEnterpriseKnowledgeProcess } from "@/lib/workflow/extractEnterpriseKnowledge";

export type WorkflowTemplateRegistryEntry = {
  id: string;
  version: string;
  domain_profile_id: string;
  label: string;
  description: string;
  /** Snapshot of the process definition (versioned; do not mutate live). */
  process: WorkflowProcessDefinition;
};

function stubProcess(
  id: string,
  title: string,
  description: string,
): WorkflowProcessDefinition {
  return {
    id,
    title,
    description,
    steps: [],
  };
}

/**
 * Versioned workflow templates keyed by DomainProfile.workflowTemplateId.
 * SAP uses the existing extract-enterprise-knowledge process under a stable id.
 */
export const WORKFLOW_TEMPLATE_REGISTRY: Record<
  string,
  WorkflowTemplateRegistryEntry
> = {
  "sap_knowledge_reconstruction.v1": {
    id: "sap_knowledge_reconstruction.v1",
    version: "1",
    domain_profile_id: "sap",
    label: "SAP Wissensrekonstruktion",
    description:
      "Versioniertes Template für den SAP-Fahrplan (Exporte → Canonical → Index).",
    process: {
      ...extractEnterpriseKnowledgeProcess,
      id: "sap_knowledge_reconstruction.v1",
    },
  },
  "website_content_index.v1": {
    id: "website_content_index.v1",
    version: "1",
    domain_profile_id: "website",
    label: "Website Content Index",
    description: "Platzhalter-Workflow für Website-Projekte.",
    process: stubProcess(
      "website_content_index.v1",
      "Website indexieren",
      "Crawler/Sitemap → Dokumente → Index (noch nicht operativ).",
    ),
  },
  "database_schema_index.v1": {
    id: "database_schema_index.v1",
    version: "1",
    domain_profile_id: "database",
    label: "Database Schema Index",
    description: "Platzhalter-Workflow für Datenbank-Projekte.",
    process: stubProcess(
      "database_schema_index.v1",
      "Datenbankschema indexieren",
      "Schema/Metadaten → Knowledge Units → Index (noch nicht operativ).",
    ),
  },
  "sharepoint_document_index.v1": {
    id: "sharepoint_document_index.v1",
    version: "1",
    domain_profile_id: "sharepoint",
    label: "SharePoint Document Index",
    description: "Platzhalter-Workflow für SharePoint-Projekte.",
    process: stubProcess(
      "sharepoint_document_index.v1",
      "SharePoint indexieren",
      "Dokumente/Listen → Knowledge Units → Index (noch nicht operativ).",
    ),
  },
};

export function resolveWorkflowTemplate(
  templateId: string | null | undefined,
): WorkflowTemplateRegistryEntry | null {
  if (!templateId) return null;
  return WORKFLOW_TEMPLATE_REGISTRY[templateId] ?? null;
}

export function workflowTemplateContentHash(
  entry: WorkflowTemplateRegistryEntry,
): string {
  return createHash("sha256")
    .update(JSON.stringify(entry.process))
    .digest("hex")
    .slice(0, 16);
}
