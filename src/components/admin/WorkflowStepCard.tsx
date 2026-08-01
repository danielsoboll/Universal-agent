"use client";

import { useMemo, useState } from "react";
import {
  grantWorkflowApprovalAction,
  openWorkflowFolderAction,
  runWorkflowPipelineAction,
  uploadWorkflowFilesAction,
  validateWorkflowStepAction,
} from "@/actions/workflow";
import { CopyButton } from "@/components/admin/CopyButton";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import type { ResolvedWorkflowStep } from "@/lib/workflow/resolve";
import type {
  WorkflowStepState,
  WorkflowStepStatus,
} from "@/lib/workflow/types";
import {
  UNCONFIGURED,
  WORKFLOW_STATUS_LABELS,
  WORKFLOW_STEP_TYPE_LABELS,
} from "@/lib/workflow/types";

function statusClass(status: WorkflowStepStatus): string {
  switch (status) {
    case "abgeschlossen":
      return "badge";
    case "fehler":
      return "badge";
    case "blockiert":
      return "badge";
    case "bereit":
      return "badge";
    default:
      return "badge";
  }
}

function statusStyle(status: WorkflowStepStatus): React.CSSProperties | undefined {
  if (status === "abgeschlossen") {
    return { background: "var(--accent-soft)" };
  }
  if (status === "fehler") {
    return { background: "var(--danger-soft)", color: "var(--danger)" };
  }
  if (status === "bereit") {
    return { background: "var(--accent-soft)" };
  }
  return undefined;
}

export function WorkflowStepCard({
  projectId,
  step,
  state,
  status,
  defaultOpen,
}: {
  projectId: string;
  step: ResolvedWorkflowStep;
  state?: WorkflowStepState;
  status: WorkflowStepStatus;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showErrors, setShowErrors] = useState(false);

  const paramsText = useMemo(
    () => step.parameters.map((p) => `${p.key}: ${p.value}`).join("\n"),
    [step.parameters],
  );

  const actions = new Set(step.actions);
  const reportUnconfigured =
    !step.transaction_or_report ||
    step.transaction_or_report.includes(UNCONFIGURED);

  return (
    <article className="panel compact overflow-hidden">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-3 py-3 text-left sm:px-4"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="muted mt-0.5 w-8 shrink-0 text-sm font-mono">
          {step.sequence}.
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold sm:text-base">
            {step.title}
          </span>
          <span className="muted mt-0.5 block text-xs sm:text-sm">
            {step.execution_location}
            {step.system_name ? ` · ${step.system_name}` : ""}
          </span>
        </span>
        <span
          className={`${statusClass(status)} shrink-0 text-[0.65rem]`}
          style={statusStyle(status)}
        >
          {WORKFLOW_STATUS_LABELS[status]}
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-[var(--border)] px-3 py-3 sm:px-4">
          <p className="text-sm">{step.short_description}</p>
          <p className="muted text-xs">
            Typ: {WORKFLOW_STEP_TYPE_LABELS[step.step_type]}
          </p>

          {(step.transaction_or_report || step.variant) && (
            <div className="space-y-1 text-sm">
              {step.transaction_or_report ? (
                <p>
                  <span className="muted">Report / Transaktion: </span>
                  <code className="text-xs">{step.transaction_or_report}</code>
                  {reportUnconfigured ? (
                    <span className="muted ml-2 text-xs">
                      ({UNCONFIGURED})
                    </span>
                  ) : null}
                </p>
              ) : null}
              {step.variant ? (
                <p>
                  <span className="muted">Variante: </span>
                  <code className="text-xs">{step.variant}</code>
                </p>
              ) : null}
            </div>
          )}

          {step.parameters.length > 0 ? (
            <div>
              <p className="label mb-1">Parameter / Werte</p>
              <ul className="space-y-1 text-sm">
                {step.parameters.map((p) => (
                  <li key={p.key} className="flex flex-wrap gap-x-2">
                    <span className="muted">{p.key}:</span>
                    <code className="break-all text-xs">{p.value}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {step.destination_path ? (
            <div className="text-sm">
              <span className="muted">Zielpfad: </span>
              <code className="break-all text-xs">{step.destination_path}</code>
            </div>
          ) : null}

          {step.expected_output ? (
            <div className="text-sm">
              <span className="muted">Erwartete Ausgabe: </span>
              {step.expected_output}
            </div>
          ) : null}

          {step.cli_command ? (
            <div className="text-sm">
              <span className="muted">CLI: </span>
              <code className="break-all text-xs">{step.cli_command}</code>
            </div>
          ) : null}

          <div>
            <p className="label mb-1">Erfolgreich, wenn</p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {step.success_criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>

          {step.warning_text ? (
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              {step.warning_text}
            </p>
          ) : null}

          {step.app_action ? (
            <p className="text-sm">
              <span className="muted">Danach in dieser App: </span>
              {step.app_action}
            </p>
          ) : null}

          {state?.last_check ? (
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-2 text-xs">
              <p className="font-medium">
                Letzte Prüfung:{" "}
                {state.last_check.ok ? "OK" : "Fehler"} ·{" "}
                {new Date(state.last_check.at).toLocaleString("de-DE")}
              </p>
              {(showErrors || !state.last_check.ok) && (
                <ul className="mt-1 list-disc pl-4">
                  {state.last_check.messages.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
              {state.last_run_log && showErrors ? (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">
                  {state.last_run_log}
                </pre>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {actions.has("copy_report") ? (
              <CopyButton
                label="Report kopieren"
                value={step.transaction_or_report}
                disabled={reportUnconfigured}
              />
            ) : null}
            {actions.has("copy_parameters") ? (
              <CopyButton label="Parameter kopieren" value={paramsText} />
            ) : null}
            {actions.has("copy_path") ? (
              <CopyButton label="Zielpfad kopieren" value={step.destination_path} />
            ) : null}
            {actions.has("copy_value") && step.cli_command ? (
              <CopyButton label="CLI kopieren" value={step.cli_command} />
            ) : null}
            {actions.has("open_guide") ? (
              <details className="w-full">
                <summary className="btn btn-secondary inline-flex cursor-pointer text-xs">
                  Anleitung öffnen
                </summary>
                <div className="mt-2 space-y-2 text-sm">
                  <p>
                    <span className="muted">Erwarteter Input: </span>
                    {step.expected_input}
                  </p>
                  <div>
                    <p className="label">Troubleshooting</p>
                    <ul className="list-disc pl-5">
                      {step.troubleshooting.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </details>
            ) : null}

            {actions.has("validate_files") ? (
              <form action={validateWorkflowStepAction}>
                <input type="hidden" name="project_id" value={projectId} />
                <input type="hidden" name="step_id" value={step.id} />
                <FormSubmitButton
                  pendingLabel="Prüfe …"
                  className="btn btn-secondary text-xs"
                >
                  Dateien prüfen
                </FormSubmitButton>
              </form>
            ) : null}

            {actions.has("open_folder") ? (
              <form action={openWorkflowFolderAction}>
                <input type="hidden" name="project_id" value={projectId} />
                <input type="hidden" name="step_id" value={step.id} />
                <FormSubmitButton
                  pendingLabel="Öffne …"
                  className="btn btn-secondary text-xs"
                >
                  Ordner öffnen
                </FormSubmitButton>
              </form>
            ) : null}

            {actions.has("start_pipeline") ? (
              <form action={runWorkflowPipelineAction}>
                <input type="hidden" name="project_id" value={projectId} />
                <input type="hidden" name="step_id" value={step.id} />
                <FormSubmitButton
                  pendingLabel="Läuft …"
                  className="btn btn-primary text-xs"
                >
                  Verarbeitung starten
                </FormSubmitButton>
              </form>
            ) : null}

            {actions.has("retry") ? (
              <form action={validateWorkflowStepAction}>
                <input type="hidden" name="project_id" value={projectId} />
                <input type="hidden" name="step_id" value={step.id} />
                <FormSubmitButton
                  pendingLabel="Erneut …"
                  className="btn btn-secondary text-xs"
                >
                  Erneut versuchen
                </FormSubmitButton>
              </form>
            ) : null}

            {actions.has("show_errors") ? (
              <button
                type="button"
                className="btn btn-secondary text-xs"
                onClick={() => setShowErrors((v) => !v)}
              >
                {showErrors ? "Fehler ausblenden" : "Fehlerdetails anzeigen"}
              </button>
            ) : null}

            {actions.has("open_report") ? (
              <a
                className="btn btn-secondary text-xs"
                href="/app"
                target="_blank"
                rel="noopener noreferrer"
              >
                Ergebnis / User-Ansicht
              </a>
            ) : null}

            {actions.has("grant_approval") ? (
              <form action={grantWorkflowApprovalAction}>
                <input type="hidden" name="project_id" value={projectId} />
                <input type="hidden" name="step_id" value={step.id} />
                <FormSubmitButton
                  pendingLabel="Freigabe …"
                  className="btn btn-primary text-xs"
                >
                  Freigabe erteilen
                </FormSubmitButton>
              </form>
            ) : null}
          </div>

          {actions.has("select_files") ? (
            <form
              action={uploadWorkflowFilesAction}
              className="space-y-2 rounded-md border border-[var(--border)] p-2"
              encType="multipart/form-data"
            >
              <input type="hidden" name="project_id" value={projectId} />
              <input type="hidden" name="step_id" value={step.id} />
              {step.id === "files.place_tables" ? (
                <select
                  className="input text-sm"
                  name="destination_subdir"
                  defaultValue="definitions"
                >
                  <option value="definitions">definitions</option>
                  <option value="contents">contents</option>
                </select>
              ) : null}
              <label className="label" htmlFor={`files-${step.id}`}>
                Dateien auswählen (.jsonl)
              </label>
              <input
                id={`files-${step.id}`}
                className="input text-sm"
                type="file"
                name="files"
                accept=".jsonl,application/jsonl,text/plain"
                multiple
              />
              <FormSubmitButton pendingLabel="Lade hoch …">
                Dateien speichern
              </FormSubmitButton>
            </form>
          ) : null}

          {state?.notes ? (
            <p className="muted text-xs">Notiz: {state.notes}</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
