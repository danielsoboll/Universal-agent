import type {
  SetupMainStepState,
  SetupSubTask,
} from "@/lib/admin/setupMainSteps";
import {
  mainStatusToFahrplanTone,
  setupStepStatusLabel,
  setupSubTaskStatusLabel,
  subTaskToFahrplanTone,
} from "@/lib/admin/setupMainSteps";
import { StatusStatusButton } from "@/components/admin/fahrplan/CompactStatus";

function SubTaskRow({ task }: { task: SetupSubTask }) {
  const tone = subTaskToFahrplanTone(task.status);
  return (
    <li className="flex items-start gap-2 border-b border-[var(--border)] py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[1.0625rem] font-medium leading-snug break-words">
          {task.label}
        </p>
        {task.detail ? (
          <p className="mt-0.5 text-[0.8125rem] leading-snug text-[var(--muted)] break-words">
            {task.detail}
          </p>
        ) : null}
      </div>
      <StatusStatusButton
        status={tone}
        label={setupSubTaskStatusLabel(task.status)}
        className="shrink-0 !min-h-0 !px-2 !py-1 !text-[0.8125rem] !font-medium"
      />
    </li>
  );
}

/** Status card + operational sub-task list for a main step detail page. */
export function SetupStepDetail({
  step,
  children,
}: {
  step: SetupMainStepState;
  children?: React.ReactNode;
}) {
  const tone = mainStatusToFahrplanTone(step.status);
  const statusLabel =
    step.progressPercent >= 100
      ? "Erledigt"
      : setupStepStatusLabel(step.status);

  return (
    <div className="space-y-3">
      <header className="min-w-0">
        <p className="text-[0.8125rem] font-medium tabular-nums text-[var(--muted)]">
          Schritt {step.id} von 6
        </p>
        <h1 className="mt-0.5 text-[1.5rem] font-semibold leading-snug tracking-tight break-words sm:text-[1.75rem]">
          {step.title}
        </h1>
        <p className="mt-1 text-[1.0625rem] leading-snug text-[var(--muted)] break-words">
          {step.purpose}
        </p>
        <p className="mt-1.5 text-[0.9375rem] font-medium tabular-nums text-[var(--muted)]">
          Fortschritt {step.progressPercent}&nbsp;%
        </p>
      </header>

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[0.875rem] font-medium text-[var(--muted)]">
            Status
          </p>
          <StatusStatusButton
            status={tone}
            label={statusLabel}
            className="shrink-0 !min-h-0 !px-2 !py-1 !text-[0.8125rem] !font-medium"
          />
        </div>
        <div
          className="progress-track mt-2 h-2 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={step.progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full ${
              step.status === "error"
                ? "progress-fill-error"
                : step.status === "done"
                  ? "progress-fill-done"
                  : step.locked
                    ? "progress-fill-locked"
                    : "progress-fill"
            }`}
            style={{ width: `${step.progressPercent}%` }}
          />
        </div>
        <p className="mt-2 text-[1.0625rem] leading-snug break-words">
          {step.statusSentence}
        </p>
      </section>

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] px-3 py-1">
        <p className="pt-2 text-[0.875rem] font-medium text-[var(--muted)]">
          Teilaufgaben
        </p>
        <ol className="mt-0.5">
          {step.subTasks.map((task) => (
            <SubTaskRow key={task.id} task={task} />
          ))}
        </ol>
      </section>

      {children}
    </div>
  );
}
