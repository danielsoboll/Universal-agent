"use client";

import { useState, useTransition, type ReactNode } from "react";
import type { FahrplanStepState } from "@/lib/rebuild/controlTablesFahrplanTypes";
import { FAHRPLAN_STEP_META } from "@/lib/rebuild/controlTablesFahrplanTypes";
import { CT_STEP_DISPLAY_TITLE } from "@/components/admin/fahrplan/controlTablesFahrplanUi";
import {
  StatusActionButton,
  StatusStatusButton,
  statusButtonClass,
} from "@/components/admin/fahrplan/CompactStatus";
import { PROJECT_ADMIN_REQUIRED_HINT } from "@/lib/onboarding/permissions";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function resultCountHint(step: FahrplanStepState): string | null {
  const c = step.result?.counts;
  if (!c) {
    const n = step.result?.files?.length;
    return n ? `${n} Datei(en)` : null;
  }
  const preferred = [
    c.definitions,
    c.rows,
    c.search_documents,
    c.index_entries,
    c.lines_checked,
  ].find((v) => v != null);
  if (preferred != null) return String(preferred);
  const first = Object.values(c).find((v) => v != null);
  return first != null ? String(first) : null;
}

function actionButtonLabel(
  step: FahrplanStepState,
  actionLabel: string,
  running: boolean,
): string {
  if (running || step.status === "running") return "Läuft…";
  if (step.status === "not_available") return "Gesperrt";
  if (step.status === "success" || step.status === "failed") {
    return `${actionLabel} (erneut)`;
  }
  return actionLabel;
}

function StepResultBlock({
  step,
  showTechDetails,
}: {
  step: FahrplanStepState;
  showTechDetails: boolean;
}) {
  const result = step.result;
  if (!result) return null;
  const techText =
    result.technical != null
      ? JSON.stringify(result.technical, null, 2)
      : "";

  const humanBits: ReactNode[] = [];

  if (result.summary) {
    humanBits.push(
      <p
        key="summary"
        className={`text-base leading-snug ${
          step.status === "failed"
            ? "text-[var(--danger)]"
            : step.status === "success"
              ? "text-emerald-800 dark:text-emerald-200"
              : "text-[var(--foreground)]"
        }`}
      >
        {result.summary}
      </p>,
    );
  }

  if (result.samples && result.samples.length > 0) {
    humanBits.push(
      <ul key="samples" className="space-y-1 text-base">
        {result.samples.map((s) => (
          <li key={s.query} className="flex gap-1.5">
            <span aria-hidden className="font-medium">
              {s.ok ? "✓" : "✕"}
            </span>
            <span>
              <span className="font-medium">{s.query}</span>
              <span className="text-[var(--muted)]"> — {s.detail}</span>
            </span>
          </li>
        ))}
      </ul>,
    );
  }

  if (result.substeps && result.substeps.length > 0) {
    humanBits.push(
      <ul key="substeps" className="space-y-1 text-base">
        {result.substeps.map((s) => (
          <li key={s.key} className="flex gap-1.5">
            <span aria-hidden className="font-medium">
              {s.ok ? "✓" : "✕"}
            </span>
            <span>
              {s.label}
              {s.detail ? (
                <span className="text-[var(--muted)]"> — {s.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>,
    );
  }

  if (result.errors && result.errors.length > 0) {
    humanBits.push(
      <details key="errors" className="text-base">
        <summary className="cursor-pointer font-medium text-[var(--danger)]">
          Fehler ({result.errors.length})
        </summary>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[var(--danger)]">
          {result.errors.slice(0, 12).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </details>,
    );
  }

  if (result.warnings && result.warnings.length > 0) {
    humanBits.push(
      <details key="warnings" className="text-base">
        <summary className="cursor-pointer font-medium text-yellow-800 dark:text-yellow-100">
          Warnungen ({result.warnings.length})
        </summary>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-yellow-900 dark:text-yellow-100/90">
          {result.warnings.slice(0, 8).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </details>,
    );
  }

  const hasTech =
    showTechDetails &&
    (Boolean(techText) ||
      Boolean(result.files?.length) ||
      Boolean(result.counts));

  if (!humanBits.length && !hasTech) return null;

  return (
    <div className="space-y-2">
      {humanBits}
      {hasTech ? (
        <details className="text-sm text-[var(--muted)]">
          <summary className="cursor-pointer font-medium hover:text-[var(--foreground)]">
            Technische Details
          </summary>
          <div className="mt-2 space-y-2">
            {result.files && result.files.length > 0 ? (
              <ul className="space-y-1">
                {result.files.map((f) => (
                  <li
                    key={f.relativePath}
                    className="break-words font-mono text-xs leading-snug"
                  >
                    {f.fileName}
                    <span className="text-[var(--muted)]">
                      {" "}
                      · {formatBytes(f.bytes)}
                      {f.system_id ? ` · ${f.system_id}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {result.counts ? (
              <p className="break-words font-mono text-xs">
                {Object.entries(result.counts)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" · ")}
              </p>
            ) : null}
            {techText ? (
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-xs leading-snug">
                {techText}
              </pre>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

const BTN_BASE =
  "btn-status-action inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-[0.9375rem] font-medium leading-none sm:min-h-12 sm:px-3 sm:py-2 sm:text-[1.0625rem]";

function ViewOnlyActionButton({
  status,
  label,
  className = "",
}: {
  status: FahrplanStepState["status"];
  label: string;
  className?: string;
}) {
  const [hint, setHint] = useState(false);
  return (
    <div className="min-w-0 shrink-0">
      <button
        type="button"
        className={`${BTN_BASE} ${statusButtonClass(status)} ${className}`}
        onClick={() => setHint(true)}
      >
        <span>{label}</span>
      </button>
      {hint ? (
        <p
          className="mt-1.5 max-w-[14rem] text-[0.8125rem] leading-snug text-[var(--warning)]"
          role="status"
        >
          {PROJECT_ADMIN_REQUIRED_HINT}
        </p>
      ) : null}
    </div>
  );
}

export function ControlTablesStepCard({
  step,
  canRun,
  showTechDetails,
  onRun,
  variant = "current",
}: {
  step: FahrplanStepState;
  canRun: boolean;
  showTechDetails: boolean;
  onRun: (stepId: number) => Promise<void>;
  /** current = sole action card; row = compact list row */
  variant?: "current" | "row";
}) {
  const meta = FAHRPLAN_STEP_META[step.id];
  const title = CT_STEP_DISPLAY_TITLE[step.id] ?? meta.title;
  const [pending, startTransition] = useTransition();
  const [rowOpen, setRowOpen] = useState(false);
  const running = pending || step.status === "running";
  const actionableStatus =
    step.status === "ready" ||
    step.status === "failed" ||
    step.status === "success";
  const executable = canRun && actionableStatus;
  const locked = step.status === "not_available";
  const countHint = resultCountHint(step);
  const hasExpandable =
    Boolean(step.result?.summary) ||
    Boolean(step.result?.files?.length) ||
    Boolean(step.result?.counts) ||
    Boolean(step.result?.errors?.length) ||
    Boolean(showTechDetails && step.result?.technical);

  const run = () => {
    startTransition(async () => {
      await onRun(step.id);
    });
  };

  const buttonLabel = actionButtonLabel(step, meta.actionLabel, running);

  if (variant === "row") {
    return (
      <li className="py-2.5">
        <div className="flex items-start gap-3">
          {hasExpandable ? (
            <button
              type="button"
              className="min-w-0 flex-1 text-left text-base leading-snug"
              onClick={() => setRowOpen((o) => !o)}
              aria-expanded={rowOpen}
            >
              <span className="font-medium">{title}</span>
              {countHint && step.status === "success" ? (
                <span className="ml-1.5 text-[var(--muted)]">{countHint}</span>
              ) : null}
            </button>
          ) : (
            <span className="min-w-0 flex-1 text-base leading-snug">
              <span className="font-medium">{title}</span>
              {countHint && step.status === "success" ? (
                <span className="ml-1.5 text-[var(--muted)]">{countHint}</span>
              ) : null}
            </span>
          )}

          {locked ? (
            <StatusStatusButton
              status={step.status}
              label="Gesperrt"
              className="shrink-0 !min-h-11 px-2.5 py-1.5 text-sm"
            />
          ) : !canRun && actionableStatus ? (
            <ViewOnlyActionButton
              status={step.status}
              label={buttonLabel}
              className="!min-h-11 px-2.5 py-1.5 text-sm"
            />
          ) : !canRun || !executable ? (
            <StatusStatusButton
              status={step.status}
              label={
                step.status === "success"
                  ? "OK"
                  : step.status === "failed"
                    ? "Fehler"
                    : step.status === "running"
                      ? "Läuft…"
                      : step.status === "ready"
                        ? meta.actionLabel
                        : "Gesperrt"
              }
              className="shrink-0 !min-h-11 px-2.5 py-1.5 text-sm"
            />
          ) : (
            <StatusActionButton
              status={step.status}
              label={buttonLabel}
              disabled={!executable || running}
              className="shrink-0 !min-h-11 px-2.5 py-1.5 text-sm"
              onClick={run}
            />
          )}
        </div>

        {rowOpen && hasExpandable ? (
          <div className="mt-2 border-l border-[var(--border)] pl-3">
            <StepResultBlock step={step} showTechDetails={showTechDetails} />
          </div>
        ) : null}
      </li>
    );
  }

  // —— Current action card ——
  return (
    <article
      className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3 sm:rounded-2xl sm:p-4"
      aria-label="Aktueller Schritt"
    >
      <h2 className="admin-card-title font-medium leading-snug tracking-tight">
        {title}
      </h2>

      <div className="mt-2 space-y-2.5">
        <StepResultBlock step={step} showTechDetails={showTechDetails} />

        {canRun ? (
          <StatusActionButton
            status={locked ? "not_available" : step.status}
            label={buttonLabel}
            disabled={!executable || running || locked}
            className="min-h-11 w-full px-3 sm:min-h-12 sm:w-auto sm:min-w-[12rem]"
            onClick={run}
          />
        ) : locked ? (
          <StatusStatusButton
            status="not_available"
            label="Gesperrt"
            className="min-h-11 w-full px-3 sm:min-h-12 sm:w-auto sm:min-w-[12rem]"
          />
        ) : (
          <ViewOnlyActionButton
            status={step.status}
            label={buttonLabel}
            className="min-h-11 w-full px-3 sm:min-h-12 sm:w-auto sm:min-w-[12rem]"
          />
        )}
      </div>
    </article>
  );
}
