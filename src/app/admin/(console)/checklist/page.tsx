import { createClient } from "@/lib/supabase/server";
import {
  primaryCustomerId,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import {
  completeManualStepAction,
  createPipelineRunStubAction,
} from "@/actions/onboarding";
import { StatusBadge } from "@/components/onboarding/StatusBadge";
import {
  WORKFLOW_PHASES,
  computeProgress,
  phaseTitle,
} from "@/lib/onboarding/phases";
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { ActionGuide } from "@/components/onboarding/ActionGuide";
import { EmptyState } from "@/components/ui/states";

export default async function AdminChecklistPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const guides = await loadUiGuideTexts([
    "admin.checklist.complete",
    "admin.checklist.pipeline",
  ]);
  const supabase = await createClient();

  const customerId = sp.customer || primaryCustomerId(ctx) || undefined;

  if (!customerId) {
    return (
      <EmptyState
        title="Kein Kunde ausgewählt"
        message="Bitte zuerst das Setup durchlaufen."
        actionHref="/admin/setup"
        actionLabel="Zum Setup"
      />
    );
  }

  await requireAdminAccess(customerId);

  const { data: workflow } = await supabase
    .from("customer_workflows")
    .select("*")
    .eq("customer_id", customerId)
    .eq("status", "active")
    .maybeSingle();

  const { data: steps } = workflow
    ? await supabase
        .from("customer_workflow_steps")
        .select("*")
        .eq("customer_workflow_id", workflow.id)
        .order("sort_order")
    : { data: [] as never[] };

  const progress = computeProgress(steps ?? []);
  const phaseOrder = new Map(WORKFLOW_PHASES.map((p) => [p.key, p.order]));
  const phases = [...new Set((steps ?? []).map((s) => s.phase_key as string))].sort(
    (a, b) => (phaseOrder.get(a) ?? 99) - (phaseOrder.get(b) ?? 99),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Fahrplan</h1>
        <p className="muted mt-1">
          {workflow
            ? `${workflow.template_key} v${workflow.template_version} · ${progress.percent}%`
            : "Noch kein aktiver Fahrplan"}
        </p>
        {workflow?.summary ? (
          <p className="mt-2 text-sm">{workflow.summary}</p>
        ) : null}
      </div>

      {!workflow ? (
        <EmptyState
          title="Noch kein Fahrplan"
          message="Bitte im Setup einen Fahrplan erzeugen."
          actionHref={`/admin/setup?customer=${customerId}&step=5`}
          actionLabel="Zum Setup"
        />
      ) : null}

      {phases.map((phase) => {
        const phaseSteps = (steps ?? []).filter((s) => s.phase_key === phase);
        return (
          <section key={phase} className="space-y-3">
            <h2 className="text-lg font-semibold">{phaseTitle(phase)}</h2>
            <div className="space-y-3">
              {phaseSteps.map((step) => {
                const manual =
                  step.completion_type === "manual_checkbox" ||
                  step.completion_type === "approval" ||
                  step.completion_type === "configuration_completed";
                const canComplete =
                  manual &&
                  !step.completed &&
                  (step.status === "ready" || step.status === "in_progress");
                const canPipeline =
                  Boolean(step.pipeline_step_key) &&
                  !step.completed &&
                  step.status !== "blocked";

                return (
                  <article key={step.id} className="panel p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span aria-hidden>
                            {step.completed ? "✓" : step.status === "blocked" ? "▣" : "○"}
                          </span>
                          <h3 className="font-semibold">{step.title}</h3>
                          <StatusBadge status={step.status} />
                          {step.required ? null : (
                            <span className="badge">optional</span>
                          )}
                        </div>
                        <p className="mt-1 text-sm muted">{step.short_description}</p>
                        <p className="mt-2 text-sm">{step.info_text}</p>
                        <details className="mt-3 text-sm">
                          <summary className="cursor-pointer font-medium">
                            Detailanweisung
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap">
                            {step.detailed_instructions}
                          </p>
                          <ul className="mt-2 list-disc space-y-1 pl-5 muted">
                            <li>
                              Voraussetzungen:{" "}
                              {((step.prerequisites as string[]) ?? []).join(", ") || "—"}
                            </li>
                            <li>
                              Erwartetes Ergebnis:{" "}
                              {((step.expected_outputs as string[]) ?? []).join(", ") ||
                                "—"}
                            </li>
                            <li>Adapter: {step.adapter_key || "—"}</li>
                            <li>Rolle: {step.responsible_role}</li>
                            <li>Abschlussart: {step.completion_type}</li>
                            {step.pipeline_step_key ? (
                              <li>Pipeline: {step.pipeline_step_key}</li>
                            ) : null}
                            {step.error_summary ? (
                              <li className="text-[var(--danger)]">
                                Fehler: {step.error_summary}
                              </li>
                            ) : null}
                            {step.result_summary ? (
                              <li>Ergebnis: {step.result_summary}</li>
                            ) : null}
                          </ul>
                        </details>
                      </div>
                      <div className="flex w-full max-w-sm flex-col gap-2">
                        {canComplete ? (
                          <>
                            <form action={completeManualStepAction}>
                              <input type="hidden" name="customer_id" value={customerId} />
                              <input type="hidden" name="step_id" value={step.id} />
                              <button type="submit" className="btn btn-primary w-full">
                                Als erledigt markieren
                              </button>
                            </form>
                            <ActionGuide guide={guides.get("admin.checklist.complete")} />
                          </>
                        ) : null}
                        {canPipeline ? (
                          <>
                            <form action={createPipelineRunStubAction}>
                              <input type="hidden" name="customer_id" value={customerId} />
                              <input type="hidden" name="step_id" value={step.id} />
                              <button type="submit" className="btn btn-secondary w-full">
                                Pipeline-Run anlegen (ready)
                              </button>
                            </form>
                            <ActionGuide guide={guides.get("admin.checklist.pipeline")} />
                          </>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
