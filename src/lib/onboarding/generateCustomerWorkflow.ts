/**
 * Deterministic customer workflow generation from templates.
 * No OpenAI required. SAP is only an adapter key in template data.
 */

export type VisibleWhen = {
  all_adapters?: string[];
  any_adapters?: string[];
  any_goals?: string[];
  all_goals?: string[];
};

export type WorkflowTemplateInput = {
  id: string;
  template_key: string;
  name: string;
  version: string;
  goal_types: string[];
  required_adapter_keys: string[];
  optional_adapter_keys: string[];
  priority: number;
  enabled: boolean;
};

export type WorkflowStepTemplateInput = {
  id: string;
  step_key: string;
  phase_key: string;
  title: string;
  short_description: string;
  detailed_instructions: string;
  info_text: string;
  sort_order: number;
  required: boolean;
  completion_type: string;
  pipeline_step_key: string | null;
  adapter_key: string | null;
  visible_when: VisibleWhen;
  prerequisites: string[];
  expected_outputs: string[];
  estimated_effort_text: string | null;
  responsible_role: string;
};

export type GenerateCustomerWorkflowInput = {
  customerId: string;
  goalTypes: string[];
  adapterKeys: string[];
  configuration?: Record<string, unknown>;
  templates: WorkflowTemplateInput[];
  stepTemplatesByTemplateId: Record<string, WorkflowStepTemplateInput[]>;
};

export type GeneratedWorkflowStep = {
  step_key: string;
  phase_key: string;
  title: string;
  short_description: string;
  detailed_instructions: string;
  info_text: string;
  sort_order: number;
  required: boolean;
  completion_type: string;
  pipeline_step_key: string | null;
  adapter_key: string | null;
  prerequisites: string[];
  expected_outputs: string[];
  responsible_role: string;
  status: "not_started" | "ready" | "blocked";
  metadata: Record<string, unknown>;
};

export type GenerateCustomerWorkflowResult = {
  template: WorkflowTemplateInput;
  steps: GeneratedWorkflowStep[];
  summary: string;
  warnings: string[];
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export function matchesVisibleWhen(
  visibleWhen: VisibleWhen | null | undefined,
  goalTypes: string[],
  adapterKeys: string[],
): boolean {
  const vw = visibleWhen ?? {};
  const goals = new Set(goalTypes);
  const adapters = new Set(adapterKeys);

  if (vw.all_adapters?.length) {
    if (!vw.all_adapters.every((k) => adapters.has(k))) return false;
  }
  if (vw.any_adapters?.length) {
    if (!vw.any_adapters.some((k) => adapters.has(k))) return false;
  }
  if (vw.all_goals?.length) {
    if (!vw.all_goals.every((k) => goals.has(k))) return false;
  }
  if (vw.any_goals?.length) {
    if (!vw.any_goals.some((k) => goals.has(k))) return false;
  }
  return true;
}

export function selectWorkflowTemplate(
  templates: WorkflowTemplateInput[],
  goalTypes: string[],
  adapterKeys: string[],
): WorkflowTemplateInput | null {
  const enabled = templates.filter((t) => t.enabled);
  const scored = enabled
    .map((t) => {
      const goals = asStringArray(t.goal_types);
      const required = asStringArray(t.required_adapter_keys);
      const optional = asStringArray(t.optional_adapter_keys);
      const goalHit = goals.filter((g) => goalTypes.includes(g)).length;
      const requiredOk = required.every((k) => adapterKeys.includes(k));
      if (!requiredOk && required.length > 0) {
        return { t, score: -1 };
      }
      // Prefer templates whose required adapters are subset and goals overlap
      const optionalHit = optional.filter((k) => adapterKeys.includes(k)).length;
      const score =
        (requiredOk ? 1000 : 0) +
        goalHit * 100 +
        required.length * 10 +
        optionalHit * 5 -
        t.priority;
      return { t, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.t.priority - b.t.priority);

  return scored[0]?.t ?? null;
}

function initialStatus(
  prerequisites: string[],
  includedKeys: Set<string>,
): "ready" | "blocked" | "not_started" {
  const prereqs = prerequisites.filter((p) => includedKeys.has(p));
  if (prereqs.length === 0) return "ready";
  return "blocked";
}

export function generateCustomerWorkflow(
  input: GenerateCustomerWorkflowInput,
): GenerateCustomerWorkflowResult {
  const warnings: string[] = [];
  const template = selectWorkflowTemplate(
    input.templates,
    input.goalTypes,
    input.adapterKeys,
  );
  if (!template) {
    throw new Error(
      "Keine passende Workflow-Vorlage für die gewählten Ziele und Adapter.",
    );
  }

  const rawSteps = input.stepTemplatesByTemplateId[template.id] ?? [];
  const visible = rawSteps
    .filter((s) =>
      matchesVisibleWhen(
        s.visible_when,
        input.goalTypes,
        input.adapterKeys,
      ),
    )
    .sort((a, b) => a.sort_order - b.sort_order);

  const includedKeys = new Set(visible.map((s) => s.step_key));

  // Validate prerequisites reference known step_keys (within template)
  const allTemplateKeys = new Set(rawSteps.map((s) => s.step_key));
  for (const step of visible) {
    for (const pre of step.prerequisites) {
      if (!allTemplateKeys.has(pre)) {
        warnings.push(
          `Schritt ${step.step_key}: unbekannte Voraussetzung ${pre}`,
        );
      }
    }
  }

  // Drop prerequisite edges to filtered-out steps
  const steps: GeneratedWorkflowStep[] = visible.map((s) => {
    const prereqs = s.prerequisites.filter((p) => includedKeys.has(p));
    return {
      step_key: s.step_key,
      phase_key: s.phase_key,
      title: s.title,
      short_description: s.short_description,
      detailed_instructions: s.detailed_instructions,
      info_text: s.info_text,
      sort_order: s.sort_order,
      required: s.required,
      completion_type: s.completion_type,
      pipeline_step_key: s.pipeline_step_key,
      adapter_key: s.adapter_key,
      prerequisites: prereqs,
      expected_outputs: s.expected_outputs,
      responsible_role: s.responsible_role,
      status: initialStatus(prereqs, includedKeys),
      metadata: {
        configuration_snapshot: input.configuration ?? {},
        source_step_template_id: s.id,
      },
    };
  });

  // Recompute ready vs blocked after prereq filtering
  for (const step of steps) {
    step.status =
      step.prerequisites.length === 0 ? "ready" : "blocked";
  }

  const summary = [
    `Vorlage: ${template.name} (${template.template_key} v${template.version})`,
    `Ziele: ${input.goalTypes.join(", ") || "—"}`,
    `Adapter: ${input.adapterKeys.join(", ") || "—"}`,
    `Schritte: ${steps.length} (davon ${steps.filter((s) => s.required).length} erforderlich)`,
  ].join(" · ");

  return { template, steps, summary, warnings };
}

export function recomputeStepStatuses(
  steps: Array<{
    step_key: string;
    status: string;
    completed: boolean;
    prerequisites: string[];
  }>,
): Map<string, string> {
  const byKey = new Map(steps.map((s) => [s.step_key, s]));
  const next = new Map<string, string>();

  for (const step of steps) {
    if (step.completed || step.status === "skipped") {
      next.set(step.step_key, step.status === "skipped" ? "skipped" : "completed");
      continue;
    }
    if (step.status === "failed" || step.status === "in_progress" || step.status === "waiting_for_input") {
      next.set(step.step_key, step.status);
      continue;
    }
    const prereqs = step.prerequisites ?? [];
    const unmet = prereqs.some((p) => {
      const pre = byKey.get(p);
      if (!pre) return false;
      return !(pre.completed || pre.status === "skipped");
    });
    next.set(step.step_key, unmet ? "blocked" : "ready");
  }
  return next;
}
