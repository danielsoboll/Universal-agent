import type { AppModuleKey } from "@/lib/onboarding/appProfileTypes";
import type { LocalProject } from "@/lib/localAuth/types";
import type {
  DomainProfile,
  DomainProfileId,
  DomainSearchProfile,
} from "@/lib/domain/types";
import { resolveDomainProfile } from "@/lib/domain/registry";
import {
  resolveAnswerSynthesizerPrompt,
  resolveQueryPlannerPrompt,
  type ResolvedAskPrompt,
} from "@/lib/core/promptRegistry";
import {
  resolveWorkflowTemplate,
  type WorkflowTemplateRegistryEntry,
} from "@/lib/domain/workflowTemplates";

/** Maps the Supabase tenant classification (customers.product_module) to a DomainProfileId. */
export function domainProfileIdForAppModule(
  module: AppModuleKey,
): DomainProfileId {
  switch (module) {
    case "sap":
      return "sap";
    case "homepage":
      return "website";
    case "database":
      return "database";
    case "general":
    default:
      return "generic_documents";
  }
}

export type ProjectCapabilities = {
  domainProfile: DomainProfile;
  domainProfileId: DomainProfileId;
  enabledAdapterIds: string[];
  knowledgeUnitTypes: readonly string[];
  entityTypes: readonly string[];
  intentTypes: readonly string[];
  targetTypes: readonly string[];
  searchProfile: DomainSearchProfile;
  plannerPrompt: ResolvedAskPrompt;
  answerPrompt: ResolvedAskPrompt;
  workflowTemplateId: string | null;
  workflowTemplate: WorkflowTemplateRegistryEntry | null;
};

/**
 * Central capability resolution for a project.
 * Domain vocabulary, prompts, search profile and workflow come only from
 * DomainProfileRegistry — never from hard-coded SAP fallbacks.
 */
export function resolveProjectCapabilities(
  project: Pick<LocalProject, "domain_profile_id" | "enabled_adapter_ids">,
): ProjectCapabilities {
  const domainProfile = resolveDomainProfile(project.domain_profile_id);
  const enabledAdapterIds =
    project.enabled_adapter_ids && project.enabled_adapter_ids.length > 0
      ? project.enabled_adapter_ids
      : [...domainProfile.defaultAdapterIds];

  const plannerPrompt = resolveQueryPlannerPrompt({
    domainPromptKey: domainProfile.plannerPromptKey,
    domainPromptVersion: domainProfile.plannerPromptVersion,
    domainExtensionFallback: domainProfile.plannerPromptExtension,
  });
  const answerPrompt = resolveAnswerSynthesizerPrompt({
    domainPromptKey: domainProfile.answerPromptKey,
    domainPromptVersion: domainProfile.answerPromptVersion,
    domainExtensionFallback: domainProfile.answerPromptExtension,
  });

  const workflowTemplateId = domainProfile.workflowTemplateId ?? null;
  const workflowTemplate = resolveWorkflowTemplate(workflowTemplateId);

  return {
    domainProfile,
    domainProfileId: domainProfile.id,
    enabledAdapterIds,
    knowledgeUnitTypes: domainProfile.knowledgeUnitTypes,
    entityTypes: domainProfile.entityTypes,
    intentTypes: domainProfile.intents,
    targetTypes: domainProfile.targetTypes,
    searchProfile: domainProfile.searchProfile,
    plannerPrompt,
    answerPrompt,
    workflowTemplateId,
    workflowTemplate,
  };
}
