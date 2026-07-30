/**
 * Explicit prompt versions for pipeline manifests and customer pins.
 * Prompt *text* stays in adapter modules — registry is the version catalog only.
 * Do not put customer- or table-specific content here.
 */

export type PromptRegistryEntry = {
  prompt_id: string;
  version: string;
  /** Logical owner module (documentation / resolution hint). */
  module: string;
  /** Structured-output schema name when applicable. */
  schema_name?: string;
  /** Free-text status for ops. */
  status: "active" | "reserved" | "deprecated";
  description: string;
};

export const PROMPT_REGISTRY: readonly PromptRegistryEntry[] = [
  {
    prompt_id: "unit_analysis",
    version: "unit-analysis-v4",
    module: "src/lib/analysis/unitAnalysisPrompt.ts",
    schema_name: "sap_code_unit_analysis_v4",
    status: "active",
    description: "ABAP code-unit structured analysis",
  },
  {
    prompt_id: "unit_analysis",
    version: "unit-analysis-v3",
    module: "src/lib/analysis/unitAnalysisPrompt.ts",
    status: "deprecated",
    description: "Previous code-unit analysis prompt",
  },
  {
    prompt_id: "control_table_analysis",
    version: "control-table-analysis-v1",
    module: "src/lib/analysis/controlTablePrompt.ts",
    schema_name: "sap_control_table_analysis_v1",
    status: "reserved",
    description: "Reserved — do not auto-run; pilot may use separately",
  },
  {
    prompt_id: "code_table_interpretation",
    version: "code-table-interpretation-v1",
    module: "src/lib/analysis/codeTableInterpretationPrompt.ts",
    schema_name: "code_table_interpretation_v1",
    status: "reserved",
    description: "Reserved joint code+table interpretation",
  },
] as const;

export function listPromptVersions(promptId: string): PromptRegistryEntry[] {
  return PROMPT_REGISTRY.filter((e) => e.prompt_id === promptId);
}

export function resolvePromptEntry(
  promptId: string,
  version: string,
): PromptRegistryEntry {
  const entry = PROMPT_REGISTRY.find(
    (e) => e.prompt_id === promptId && e.version === version,
  );
  if (!entry) {
    throw new Error(
      `Prompt nicht in Registry: ${promptId}@${version}. Bekannt: ${PROMPT_REGISTRY.map(
        (e) => `${e.prompt_id}@${e.version}`,
      ).join(", ")}`,
    );
  }
  return entry;
}

export function activePromptVersion(promptId: string): string {
  const active = PROMPT_REGISTRY.find(
    (e) => e.prompt_id === promptId && e.status === "active",
  );
  if (!active) {
    throw new Error(`Keine active Prompt-Version für ${promptId}`);
  }
  return active.version;
}
