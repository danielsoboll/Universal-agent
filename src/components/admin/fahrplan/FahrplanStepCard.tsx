import { StatusBadge } from "@/components/onboarding/StatusBadge";
import { GuideInfoButton } from "@/components/ui/GuideInfoButton";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";
import {
  createPipelineRunStubAction,
} from "@/actions/onboarding";
import {
  executionHint,
  getStepDisplayStatus,
  parseInfoText,
  softenResultSummary,
  softenShortDescription,
  type FahrplanStepLike,
  type StepDisplayStatus,
} from "@/lib/onboarding/stepDisplay";

export type FahrplanStepRow = FahrplanStepLike & {
  id: string;
  title: string;
  short_description: string | null;
  info_text: string | null;
  detailed_instructions: string | null;
  expected_outputs: string[] | null;
  prerequisites: string[] | null;
  required: boolean;
  completed: boolean;
  status: string;
  completion_type: string;
  pipeline_step_key: string | null;
  adapter_key: string | null;
  responsible_role: string;
  error_summary: string | null;
  result_summary: string | null;
  phase_key: string;
  step_key: string;
  sort_order: number;
};

function InfoDefinitionList({
  info,
  result,
}: {
  info: ReturnType<typeof parseInfoText>;
  result: string | null;
}) {
  return (
    <dl className="grid gap-1.5 text-sm">
      {info.was ? (
        <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 sm:grid-cols-[6.5rem_1fr]">
          <dt className="text-xs font-medium text-[var(--muted)]">Was</dt>
          <dd className="text-sm leading-snug">{info.was}</dd>
        </div>
      ) : null}
      {info.warum ? (
        <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 sm:grid-cols-[6.5rem_1fr]">
          <dt className="text-xs font-medium text-[var(--muted)]">Warum</dt>
          <dd className="text-sm leading-snug">{info.warum}</dd>
        </div>
      ) : null}
      {info.ergebnis || result ? (
        <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 sm:grid-cols-[6.5rem_1fr]">
          <dt className="text-xs font-medium text-[var(--muted)]">Ergebnis</dt>
          <dd className="text-sm leading-snug">{result ?? info.ergebnis}</dd>
        </div>
      ) : null}
      {info.fertigWenn ? (
        <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 sm:grid-cols-[6.5rem_1fr]">
          <dt className="text-xs font-medium text-[var(--muted)]">Fertig wenn</dt>
          <dd className="text-sm leading-snug">{info.fertigWenn}</dd>
        </div>
      ) : null}
      {!info.was && !info.warum && info.remainder ? (
        <p className="text-sm leading-snug">{info.remainder}</p>
      ) : null}
    </dl>
  );
}

export function FahrplanStepCard({
  step,
  customerId,
  displayStatus,
  variant = "list",
  defaultDetailsOpen = false,
  guideComplete,
  guidePipeline,
  showPrimaryActions = true,
}: {
  step: FahrplanStepRow;
  customerId: string;
  displayStatus?: StepDisplayStatus;
  variant?: "list" | "next";
  defaultDetailsOpen?: boolean;
  guideComplete?: { title?: string; body?: string };
  guidePipeline?: { title?: string; body?: string };
  showPrimaryActions?: boolean;
}) {
  const display = displayStatus ?? getStepDisplayStatus(step);
  const info = parseInfoText(step.info_text);
  const short = softenShortDescription(step.short_description);
  const result = softenResultSummary(step.result_summary);
  const where = executionHint(step);
  const isNext = variant === "next";

  const manual =
    step.completion_type === "manual_checkbox" ||
    step.completion_type === "approval" ||
    step.completion_type === "configuration_completed";
  const canComplete =
    showPrimaryActions &&
    manual &&
    !step.completed &&
    (step.status === "ready" || step.status === "in_progress");
  const canPipeline =
    showPrimaryActions &&
    Boolean(step.pipeline_step_key) &&
    !step.completed &&
    step.status !== "blocked" &&
    step.status !== "failed";

  return (
    <article
      className={`panel compact overflow-hidden ${
        isNext
          ? "ring-1 ring-[color-mix(in_srgb,var(--accent)_35%,var(--border))]"
          : ""
      }`}
    >
      <div className="flex items-start gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
        <span
          className="mt-0.5 shrink-0 text-sm leading-none text-[var(--muted)]"
          aria-hidden
        >
          {step.completed ? "✓" : display === "blocked" ? "!" : "○"}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3
              className={`min-w-0 text-sm font-semibold leading-snug sm:text-[0.95rem] ${
                isNext ? "sm:text-base" : ""
              }`}
            >
              {step.title}
            </h3>
            <StatusBadge status={step.status} displayStatus={display} />
            {!step.required ? (
              <span className="inline-flex rounded-md bg-[var(--surface-raised)] px-1.5 py-0.5 text-[0.65rem] font-medium text-[var(--muted)] ring-1 ring-[var(--border)] sm:text-xs">
                Optional
              </span>
            ) : null}
          </div>
          <p className="text-xs leading-snug text-[var(--muted)] sm:text-sm">
            <span className="font-medium text-[color-mix(in_srgb,var(--foreground)_80%,var(--muted))]">
              {where}
            </span>
            {short ? <span> · {short}</span> : null}
          </p>
        </div>
      </div>

      <div className="space-y-2 border-t border-[var(--border)] px-3 py-2 sm:px-4 sm:py-2.5">
        {isNext ? (
          <InfoDefinitionList info={info} result={result} />
        ) : (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium text-[var(--muted)]">
              Kurzinfo
            </summary>
            <div className="mt-2">
              <InfoDefinitionList info={info} result={result} />
            </div>
          </details>
        )}

        {step.error_summary ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium text-[var(--danger)]">
              Fehlerdetails
            </summary>
            <p className="mt-1 text-xs text-[var(--danger)] sm:text-sm">
              {step.error_summary}
            </p>
          </details>
        ) : null}

        <details className="text-sm" open={defaultDetailsOpen}>
          <summary className="cursor-pointer text-xs font-medium text-[var(--muted)] underline-offset-2 hover:underline">
            Anleitung
          </summary>
          <div className="mt-2 space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-2.5 text-sm">
            {step.detailed_instructions ? (
              <p className="whitespace-pre-wrap leading-snug">
                {step.detailed_instructions}
              </p>
            ) : null}
            <ul className="space-y-1 text-xs text-[var(--muted)]">
              <li>
                Voraussetzungen:{" "}
                {(step.prerequisites ?? []).join(", ") || "—"}
              </li>
              <li>
                Erwartetes Ergebnis:{" "}
                {(step.expected_outputs ?? []).join(", ") || "—"}
              </li>
              <li>Rolle: {step.responsible_role || "—"}</li>
              <li>Abschlussart: {step.completion_type || "—"}</li>
              {step.adapter_key ? <li>Adapter: {step.adapter_key}</li> : null}
              {step.pipeline_step_key ? (
                <li>Pipeline: {step.pipeline_step_key}</li>
              ) : null}
              {step.step_key ? <li>Schritt-ID: {step.step_key}</li> : null}
            </ul>
          </div>
        </details>

        {(canComplete || canPipeline) && (
          <div className="flex flex-col gap-2 pt-0.5 sm:flex-row sm:flex-wrap sm:items-center">
            {canComplete ? (
              <PressNavigateLink
                href="/admin/steps/4"
                className="btn btn-primary px-3 py-2 text-xs sm:text-sm"
              >
                Zum technischen Import
              </PressNavigateLink>
            ) : null}
            {canPipeline ? (
              <div className="flex items-center gap-1.5">
                <form action={createPipelineRunStubAction} className="min-w-0">
                  <input type="hidden" name="customer_id" value={customerId} />
                  <input type="hidden" name="step_id" value={step.id} />
                  <button
                    type="submit"
                    className="btn btn-primary px-3 py-2 text-xs sm:text-sm"
                  >
                    Verarbeitung starten
                  </button>
                </form>
                <GuideInfoButton
                  title={guidePipeline?.title ?? "Verarbeitung"}
                  body={guidePipeline?.body}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}
