"use client";

import { useEffect, useState, useTransition } from "react";
import {
  getControlTablesRebuildStatus,
  startControlTablesRebuildAction,
  type RebuildUiStatus,
} from "@/actions/rebuildData";
import { REBUILD_STATUS_STEPS, REBUILD_STATUS_LABELS_DE } from "@/lib/rebuild/types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function RebuildDataPanel({
  initial,
  projectKey = "P01",
}: {
  initial: RebuildUiStatus;
  projectKey?: string;
}) {
  const [status, setStatus] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const running =
    pending ||
    status.step === "running" ||
    (status.step !== "idle" &&
      status.step !== "done" &&
      status.step !== "error" &&
      status.steps_completed.length > 0 &&
      !status.steps_completed.includes("done"));

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      void getControlTablesRebuildStatus(projectKey).then(setStatus);
    }, 2000);
    return () => clearInterval(id);
  }, [running, projectKey]);

  const onRebuild = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await startControlTablesRebuildAction(projectKey);
      setMessage(res.message);
      const next = await getControlTablesRebuildStatus(projectKey);
      setStatus(next);
    });
  };

  const completed = new Set(status.steps_completed);

  return (
    <div className="space-y-4">
      <section className="panel compact space-y-3 p-4 sm:p-5">
        <div>
          <h2 className="text-base font-semibold sm:text-lg">
            Steuer-/Customizing-Tabellen
          </h2>
        </div>

        <div
          className="rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/5 px-3 py-2 text-sm text-[var(--foreground)]"
          role="status"
        >
          Beim Neuaufbau werden alle bisher aus dieser Datenart erzeugten Daten
          endgültig ersetzt.
        </div>

        <div>
          <p className="muted text-xs uppercase tracking-wide">
            Erkannte aktuelle RAW-Datei(en)
          </p>
          {status.source_files.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--danger)]">{status.source_message}</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {status.source_files.map((f) => (
                <li key={f.relativePath}>
                  <code className="text-xs">{f.relativePath}</code>
                  <span className="muted ml-2 text-xs">
                    {formatBytes(f.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!status.source_ok && status.source_files.length > 0 ? (
            <p className="mt-2 text-sm text-[var(--danger)]">{status.source_message}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!status.source_ok || running}
            onClick={onRebuild}
          >
            {running ? "Aufbau läuft…" : "Daten neu aufbauen"}
          </button>
          {message ? <p className="text-sm">{message}</p> : null}
        </div>
      </section>

      <section className="panel compact space-y-3 p-4 sm:p-5">
        <h3 className="text-sm font-semibold">Status</h3>
        <ol className="space-y-2">
          {REBUILD_STATUS_STEPS.map((step) => {
            const done = completed.has(step) || status.step === "done";
            const current = status.step === step;
            return (
              <li
                key={step}
                className={`flex items-start gap-2 text-sm ${
                  done
                    ? "text-[var(--foreground)]"
                    : current
                      ? "text-[var(--accent)]"
                      : "text-[var(--muted)]"
                }`}
              >
                <span aria-hidden className="mt-0.5 w-4 shrink-0">
                  {done ? "✓" : current ? "●" : "○"}
                </span>
                <span>{REBUILD_STATUS_LABELS_DE[step]}</span>
              </li>
            );
          })}
        </ol>
        {status.detail ? (
          <p className="muted text-xs">{status.detail}</p>
        ) : null}
        {status.error ? (
          <p className="text-sm text-[var(--danger)]">{status.error}</p>
        ) : null}
      </section>

      {status.last_report ? (
        <section className="panel compact space-y-2 p-4 sm:p-5">
          <h3 className="text-sm font-semibold">Letzter Lauf</h3>
          <dl className="grid gap-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="muted text-xs">Canonical</dt>
              <dd>{status.last_report.canonical_records ?? "—"}</dd>
            </div>
            <div>
              <dt className="muted text-xs">SearchDocuments</dt>
              <dd>{status.last_report.search_documents ?? "—"}</dd>
            </div>
            <div>
              <dt className="muted text-xs">Embeddings</dt>
              <dd>{status.last_report.embeddings ?? "—"}</dd>
            </div>
            <div>
              <dt className="muted text-xs">Alter Stand gelöscht</dt>
              <dd>
                {status.last_report.old_deleted == null &&
                status.last_report.derived_replaced == null
                  ? "—"
                  : status.last_report.old_deleted ||
                      status.last_report.derived_replaced
                    ? "ja"
                    : "nein"}
              </dd>
            </div>
            <div>
              <dt className="muted text-xs">Erfolg</dt>
              <dd>
                {status.last_report.success == null
                  ? status.last_report.smoke_ok == null
                    ? "—"
                    : status.last_report.smoke_ok
                      ? "ja"
                      : "nein"
                  : status.last_report.success
                    ? "ja"
                    : "nein"}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
