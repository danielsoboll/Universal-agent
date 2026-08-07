"use client";

import { useState, useTransition } from "react";
import { runDatenbasisStepAction } from "@/actions/datenbasis";
import {
  DATENBASIS_STEP_META,
  type ExportTypeConfig,
} from "@/lib/admin/datenbasis/exportTypeConfig";
import {
  DATENBASIS_STEP_IDS,
  type DatenbasisManifest,
  type DatenbasisStepId,
} from "@/lib/admin/datenbasis/types";
import {
  StatusActionButton,
  StatusStatusButton,
} from "@/components/admin/fahrplan/CompactStatus";
import type { FahrplanStepStatus } from "@/lib/rebuild/controlTablesFahrplanTypes";
import { PROJECT_ADMIN_REQUIRED_HINT } from "@/lib/onboarding/permissions";
import { MessageIdocConfigPanel } from "@/components/admin/datenbasis/MessageIdocConfigPanel";
import type {
  MessageIdocRawManifest,
  MessageIdocStatusSnapshot,
} from "@/lib/admin/datenbasis/messageIdocConfig/types";

function stepTone(status: string): FahrplanStepStatus {
  switch (status) {
    case "done":
      return "success";
    case "error":
      return "failed";
    case "running":
      return "running";
    case "locked":
    case "ready":
    case "awaiting":
    case "open":
    default:
      return "ready";
  }
}

function stepLabel(status: string): string {
  switch (status) {
    case "done":
      return "OK";
    case "error":
      return "Fehler";
    case "running":
      return "Läuft";
    case "locked":
      return "Offen";
    case "awaiting":
      return "Freigabe";
    case "ready":
      return "Bereit";
    case "open":
      return "Offen";
    default:
      return "Offen";
  }
}

export function ExportTypeDetailView({
  config,
  initial,
  projectKey,
  customerId,
  canRun,
  messageIdoc,
}: {
  config: ExportTypeConfig;
  initial: DatenbasisManifest;
  projectKey: string;
  customerId?: string | null;
  canRun: boolean;
  messageIdoc?: {
    status: MessageIdocStatusSnapshot;
    manifest: MessageIdocRawManifest | null;
    plannedModel: {
      object_types: readonly string[];
      relation_kinds: readonly string[];
      note: string;
    };
  };
}) {
  const [manifest, setManifest] = useState(initial);
  const [flash, setFlash] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>(
    initial.selected_raw_file ?? "",
  );
  const [pending, startTransition] = useTransition();

  if (config.id === "message-idoc-config" && messageIdoc) {
    return (
      <MessageIdocConfigPanel
        config={config}
        projectKey={projectKey}
        customerId={customerId}
        initialStatus={messageIdoc.status}
        initialManifest={messageIdoc.manifest}
        plannedModel={messageIdoc.plannedModel}
        canRun={canRun}
      />
    );
  }

  const run = (stepId: DatenbasisStepId, confirm?: boolean) => {
    if (!canRun) {
      setFlash(PROJECT_ADMIN_REQUIRED_HINT);
      return;
    }
    setFlash(null);
    startTransition(async () => {
      const res = await runDatenbasisStepAction({
        projectKey,
        exportTypeId: config.id,
        stepId,
        selectedRawFile: selectedFile || null,
        confirm,
        customerId,
      });
      setManifest(res.manifest);
      setFlash(res.message);
      if (res.manifest.selected_raw_file) {
        setSelectedFile(res.manifest.selected_raw_file);
      }
    });
  };

  if (config.implementation !== "full") {
    return (
      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <h2 className="text-[1.125rem] font-medium">{config.title}</h2>
        <p className="mt-1 text-[0.9375rem] text-[var(--muted)]">
          {config.description}
        </p>
        <p className="mt-2 text-[0.9375rem]">
          Status:{" "}
          {manifest.unlocked
            ? "Vorbereitet / Scaffold — Pipeline noch nicht freigeschaltet"
            : "Offen — Scaffold"}
        </p>
        <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">
          certainty: {config.certainty}
          {config.evidenceNotes[0] ? ` — ${config.evidenceNotes[0]}` : ""}
        </p>
      </section>
    );
  }

  const candidates =
    (manifest.steps.B_raw_detect.result?.technical
      ?.candidates as string[] | undefined) ??
    manifest.steps.B_raw_detect.result?.files?.map((f) => f.fileName) ??
    [];

  return (
    <div className="space-y-3">
      <header className="min-w-0">
        <h2 className="text-[1.25rem] font-semibold leading-snug">
          {config.title}
        </h2>
        <p className="mt-0.5 text-[0.9375rem] text-[var(--muted)]">
          {config.description}
        </p>
        <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">
          Report: {config.sapReport ?? "—"}
          {config.rawFolder ? ` · Ziel: ${config.rawFolder}` : ""}
          {config.headerExportType
            ? ` · Header export_type: ${config.headerExportType}`
            : ""}
        </p>
      </header>

      {flash ? (
        <p className="text-[0.9375rem] text-[var(--muted)]" role="status">
          {flash}
        </p>
      ) : null}

      {candidates.length > 1 ? (
        <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
          <p className="text-[0.875rem] font-medium text-[var(--muted)]">
            RAW-Datei wählen
          </p>
          <select
            className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[1rem]"
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
          >
            <option value="">— auswählen —</option>
            {candidates.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      <ol className="space-y-2">
        {DATENBASIS_STEP_IDS.map((id) => {
          const step = manifest.steps[id];
          const meta = DATENBASIS_STEP_META[id]!;
          const actionable =
            step.status === "ready" ||
            step.status === "awaiting" ||
            step.status === "error" ||
            step.status === "open" ||
            step.status === "locked";
          const isManual = id === "A_sap_export" || id === "G_approve";

          return (
            <li
              key={id}
              className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[1.0625rem] font-medium leading-snug">
                    {id.replace(/_/g, " ").slice(0, 1)}. {meta.title}
                  </p>
                  <p className="mt-0.5 text-[0.8125rem] text-[var(--muted)]">
                    {meta.description}
                  </p>
                  {step.result?.summary ? (
                    <p className="mt-1 text-[0.875rem] break-words">
                      {step.result.summary}
                    </p>
                  ) : null}
                  {step.result?.errors?.length ? (
                    <ul className="mt-1 text-[0.8125rem] text-[var(--muted)]">
                      {step.result.errors.slice(0, 3).map((e) => (
                        <li key={e} className="break-words">
                          {e}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {step.result?.cases?.length ? (
                    <ul className="mt-1 space-y-0.5 text-[0.8125rem]">
                      {step.result.cases.map((c) => (
                        <li key={c.question} className="break-words">
                          {c.ok ? "✓" : "✗"} {c.question}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {step.result?.samples?.length ? (
                    <ul className="mt-1 space-y-0.5 text-[0.8125rem] text-[var(--muted)]">
                      {step.result.samples.map((s) => (
                        <li key={s.query} className="break-words">
                          {s.ok ? "✓" : "✗"} {s.query}: {s.detail.slice(0, 100)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusStatusButton
                    status={stepTone(step.status)}
                    label={stepLabel(step.status)}
                    className="!min-h-0 !px-2 !py-1 !text-[0.8125rem]"
                  />
                  {actionable && (manifest.unlocked || config.unlockIndependent) ? (
                    <StatusActionButton
                      status={
                        step.status === "error" ? "failed" : "ready"
                      }
                      label={
                        pending
                          ? "…"
                          : isManual
                            ? meta.actionLabel
                            : meta.actionLabel
                      }
                      disabled={pending || !canRun}
                      onClick={() => run(id, isManual ? true : undefined)}
                      className="!min-h-0 !px-2 !py-1 !text-[0.8125rem]"
                    />
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
