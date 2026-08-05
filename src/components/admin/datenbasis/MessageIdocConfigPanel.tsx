"use client";

import { useState, useTransition } from "react";
import {
  getMessageIdocConfigStatusAction,
  prepareMessageIdocConfigAction,
} from "@/actions/datenbasis";
import type { ExportTypeConfig } from "@/lib/admin/datenbasis/exportTypeConfig";
import {
  AREA_STATUS_LABELS,
  AREA_STATUS_VALUES,
  CONFIG_GROUPS,
  EXPECTED_GROUPS,
  type MessageIdocAreaStatus,
} from "@/lib/admin/datenbasis/messageIdocConfig/constants";
import type {
  MessageIdocRawManifest,
  MessageIdocStatusSnapshot,
} from "@/lib/admin/datenbasis/messageIdocConfig/types";
import {
  StatusActionButton,
  StatusStatusButton,
} from "@/components/admin/fahrplan/CompactStatus";
import type { FahrplanStepStatus } from "@/lib/rebuild/controlTablesFahrplanTypes";
import { PROJECT_ADMIN_REQUIRED_HINT } from "@/lib/onboarding/permissions";

function statusTone(status: MessageIdocAreaStatus): FahrplanStepStatus {
  switch (status) {
    case "keine_dateien":
      return "not_available";
    case "unvollstaendig":
      return "failed";
    case "konvertiert":
    case "indexiert":
    case "bereit_fuer_mapping":
      return "success";
    case "schema_profiliert":
    case "validiert":
    case "alle_gruppen_erkannt":
      return "ready";
    default:
      return "ready";
  }
}

const PIPELINE_STEPS: Array<{
  id: MessageIdocAreaStatus;
  label: string;
  future?: boolean;
}> = AREA_STATUS_VALUES.map((id) => ({
  id,
  label: AREA_STATUS_LABELS[id],
  future: id === "konvertiert" || id === "indexiert",
}));

function rank(status: MessageIdocAreaStatus): number {
  return AREA_STATUS_VALUES.indexOf(status);
}

export function MessageIdocConfigPanel({
  config,
  projectKey,
  customerId,
  initialStatus,
  initialManifest,
  plannedModel,
  canRun,
}: {
  config: ExportTypeConfig;
  projectKey: string;
  customerId?: string | null;
  initialStatus: MessageIdocStatusSnapshot;
  initialManifest: MessageIdocRawManifest | null;
  plannedModel: {
    object_types: readonly string[];
    relation_kinds: readonly string[];
    note: string;
  };
  canRun: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [manifest, setManifest] = useState(initialManifest);
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const runPrepare = () => {
    if (!canRun) {
      setFlash(PROJECT_ADMIN_REQUIRED_HINT);
      return;
    }
    startTransition(async () => {
      const res = await prepareMessageIdocConfigAction({
        projectKey,
        customerId,
      });
      setStatus(res.status);
      setManifest(res.manifest);
      setFlash(res.message);
    });
  };

  const refresh = () => {
    startTransition(async () => {
      const res = await getMessageIdocConfigStatusAction({ projectKey });
      setStatus(res.status);
      setManifest(res.manifest);
      setFlash("Status aktualisiert");
    });
  };

  const currentRank = rank(status.status);

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
          Pipeline: MESSAGE_IDOC_CONFIG · {EXPECTED_GROUPS} Exportgruppen · Ziel:{" "}
          {config.rawFolder}
        </p>
      </header>

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[0.875rem] font-medium text-[var(--muted)]">
              Bereichsstatus
            </p>
            <p className="mt-1 text-[1.0625rem] font-medium">
              {status.status_label}
            </p>
            <p className="mt-0.5 text-[0.8125rem] text-[var(--muted)]">
              {status.detected_groups}/{status.expected_groups} Gruppen ·{" "}
              {status.file_count} Datei(en) · {status.valid_rows_total} gültig ·{" "}
              {status.invalid_rows_total} ungültig · {status.profiles_written}{" "}
              Tabellenprofile
            </p>
          </div>
          <StatusStatusButton
            status={statusTone(status.status)}
            label={status.status_label}
            className="!min-h-0 !px-2 !py-1 !text-[0.8125rem]"
          />
        </div>

        <ol className="mt-3 space-y-1.5">
          {PIPELINE_STEPS.map((step) => {
            const stepRank = rank(step.id);
            const active = status.status === step.id;
            const reached =
              !step.future &&
              (status.status === "keine_dateien"
                ? step.id === "keine_dateien"
                : stepRank <= currentRank && step.id !== "keine_dateien");
            return (
              <li
                key={step.id}
                className="flex items-center justify-between gap-2 text-[0.875rem]"
              >
                <span
                  className={
                    active
                      ? "font-medium"
                      : reached
                        ? "text-[var(--muted)]"
                        : "text-[var(--muted)] opacity-70"
                  }
                >
                  {step.label}
                  {step.future ? " (später)" : ""}
                </span>
                <span className="text-[0.75rem] text-[var(--muted)]">
                  {active ? "aktuell" : reached ? "erreicht" : "—"}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {flash ? (
        <p className="text-[0.9375rem] text-[var(--muted)]" role="status">
          {flash}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <StatusActionButton
          status={pending ? "running" : "ready"}
          label={pending ? "Läuft…" : "RAW prüfen & Schema profilieren"}
          onClick={runPrepare}
          disabled={pending || !canRun}
          className="!min-h-10"
        />
        <button
          type="button"
          className="btn btn-secondary btn-quiet min-h-10 px-3 text-[0.9375rem]"
          onClick={refresh}
          disabled={pending}
        >
          Aktualisieren
        </button>
      </div>

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <p className="text-[0.875rem] font-medium text-[var(--muted)]">
          Erwartete Gruppen ({EXPECTED_GROUPS})
        </p>
        <ul className="mt-2 space-y-1">
          {CONFIG_GROUPS.map((g) => {
            const found = manifest?.detected_groups.includes(g) ?? false;
            const missing = manifest?.missing_groups.includes(g) ?? true;
            return (
              <li
                key={g}
                className="flex items-center justify-between gap-2 text-[0.8125rem]"
              >
                <span className="break-words">{g}</span>
                <span className="shrink-0 text-[var(--muted)]">
                  {found ? "gefunden" : missing ? "fehlt" : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {manifest ? (
        <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
          <p className="text-[0.875rem] font-medium text-[var(--muted)]">
            Erkannte RAW-Dateien
          </p>
          {manifest.files.length === 0 ? (
            <p className="mt-2 text-[0.9375rem] text-[var(--muted)]">
              Keine JSONL unter raw/message-idoc-config/
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {manifest.files.map((f) => (
                <li
                  key={f.path}
                  className="text-[0.875rem] leading-snug break-words"
                >
                  <span className="font-medium">{f.fileName}</span>
                  <span className="text-[var(--muted)]">
                    {" "}
                    · {f.config_group ?? "?"} · {f.formal_status_label}
                    {" · "}
                    {f.rows_read} Datenzeilen · {f.valid_rows} gültig /{" "}
                    {f.invalid_rows} ungültig
                    {f.tables_missing > 0
                      ? ` · ${f.tables_missing} Tabellen fehlen`
                      : ""}
                  </span>
                  {Object.keys(f.rows_by_source_table).length > 0 ? (
                    <p className="mt-0.5 text-[0.75rem] text-[var(--muted)]">
                      Tabellen:{" "}
                      {Object.entries(f.rows_by_source_table)
                        .map(([t, n]) => `${t} (${n})`)
                        .join(", ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[0.8125rem] text-[var(--muted)]">
            Manifest: logs/message-idoc-config/raw-manifest.json
            {manifest.schema_hash
              ? ` · schema_hash ${manifest.schema_hash}`
              : ""}
          </p>
        </section>
      ) : null}

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <p className="text-[0.875rem] font-medium text-[var(--muted)]">
          Geplantes Canonical-Modell
        </p>
        <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">
          {plannedModel.note}
        </p>
        <p className="mt-2 text-[0.8125rem] break-words">
          Objekte: {plannedModel.object_types.join(", ")}
        </p>
        <p className="mt-1 text-[0.8125rem] break-words text-[var(--muted)]">
          Relationen: {plannedModel.relation_kinds.join(", ")}
        </p>
      </section>
    </div>
  );
}
