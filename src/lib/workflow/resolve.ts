import {
  applyPlaceholders,
  buildPlaceholderMap,
} from "@/lib/workflow/placeholders";
import type { LocalProject } from "@/lib/localAuth/types";
import type {
  WorkflowParameter,
  WorkflowProcessDefinition,
  WorkflowStepDefinition,
} from "@/lib/workflow/types";

export type ResolvedWorkflowStep = Omit<
  WorkflowStepDefinition,
  "parameters" | "success_criteria" | "troubleshooting" | "file_patterns" | "output_checks"
> & {
  parameters: WorkflowParameter[];
  success_criteria: string[];
  troubleshooting: string[];
  file_patterns: string[];
  output_checks: string[];
  unresolved_placeholders: string[];
};

function resolveText(text: string, map: Record<string, string>): string {
  return applyPlaceholders(text, map);
}

function collectUnresolved(text: string): string[] {
  const out: string[] = [];
  const re = /\$\{([A-Z0-9_]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(m[1]!);
  }
  return out;
}

export function resolveWorkflowStep(
  step: WorkflowStepDefinition,
  project: LocalProject,
): ResolvedWorkflowStep {
  const map = buildPlaceholderMap(project);
  const resolve = (s: string) => resolveText(s, map);

  const parameters = step.parameters.map((p) => ({
    key: p.key,
    value: resolve(p.value),
  }));
  const success_criteria = step.success_criteria.map(resolve);
  const troubleshooting = step.troubleshooting.map(resolve);
  const file_patterns = step.file_patterns.map(resolve);
  const output_checks = (step.output_checks ?? []).map(resolve);

  const blob = [
    step.system_name,
    step.transaction_or_report,
    step.variant,
    step.short_description,
    step.expected_input,
    step.expected_output,
    step.destination_path,
    step.app_action,
    step.warning_text,
    step.cli_command ?? "",
    ...parameters.map((p) => p.value),
    ...success_criteria,
    ...troubleshooting,
  ].join("\n");

  return {
    ...step,
    system_name: resolve(step.system_name),
    transaction_or_report: resolve(step.transaction_or_report),
    variant: resolve(step.variant),
    short_description: resolve(step.short_description),
    expected_input: resolve(step.expected_input),
    expected_output: resolve(step.expected_output),
    destination_path: resolve(step.destination_path),
    app_action: resolve(step.app_action),
    warning_text: resolve(step.warning_text),
    cli_command: step.cli_command ? resolve(step.cli_command) : null,
    parameters,
    success_criteria,
    troubleshooting,
    file_patterns,
    output_checks,
    unresolved_placeholders: collectUnresolved(blob),
  };
}

export function resolveProcess(
  process: WorkflowProcessDefinition,
  project: LocalProject,
): ResolvedWorkflowStep[] {
  return process.steps
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => resolveWorkflowStep(s, project));
}
