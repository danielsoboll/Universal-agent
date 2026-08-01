import type { LocalProject } from "@/lib/localAuth/types";
import type { WorkflowProcessDefinition } from "@/lib/workflow/types";
import { resolveProjectCapabilities } from "@/lib/domain/capabilities";

/**
 * Active workflow process for a project — loaded from DomainProfile.workflowTemplateId.
 * No hard-coded SAP process fallback outside the sap profile's registered template.
 */
export function resolveActiveWorkflowProcess(
  project: Pick<LocalProject, "domain_profile_id" | "enabled_adapter_ids">,
): WorkflowProcessDefinition {
  const caps = resolveProjectCapabilities(project);
  if (caps.workflowTemplate?.process) {
    return caps.workflowTemplate.process;
  }
  return {
    id: "workflow.none",
    title: "Kein Workflow",
    description: `Für Domain Profile „${caps.domainProfileId}“ ist kein Workflow-Template hinterlegt.`,
    steps: [],
  };
}

export function resolveActiveWorkflowTemplateId(
  project: Pick<LocalProject, "domain_profile_id" | "enabled_adapter_ids">,
): string | null {
  return resolveProjectCapabilities(project).workflowTemplateId;
}
