"use client";

import { useState, useTransition } from "react";
import {
  confirmStage2CompleteAction,
  ensureProjectStructureAction,
} from "@/actions/projectStructure";
import type { SetupStage2State } from "@/lib/admin/datenbasis/types";
import { StatusActionButton, StatusStatusButton } from "@/components/admin/fahrplan/CompactStatus";
import { PROJECT_ADMIN_REQUIRED_HINT } from "@/lib/onboarding/permissions";

export function Stage2StructurePanel({
  initial,
  projectKey,
  customerId,
  canRun,
}: {
  initial: SetupStage2State;
  projectKey: string;
  customerId?: string | null;
  canRun: boolean;
}) {
  const [state, setState] = useState(initial);
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const foldersTone = state.folders_ok ? "success" : "ready";
  const done = state.folders_ok && state.manual_complete;

  const onEnsure = () => {
    if (!canRun) {
      setFlash(PROJECT_ADMIN_REQUIRED_HINT);
      return;
    }
    setFlash(null);
    startTransition(async () => {
      const res = await ensureProjectStructureAction({
        projectKey,
        customerId,
      });
      setState(res.state);
      setFlash(res.message);
    });
  };

  const onConfirm = () => {
    if (!canRun) {
      setFlash(PROJECT_ADMIN_REQUIRED_HINT);
      return;
    }
    setFlash(null);
    startTransition(async () => {
      const res = await confirmStage2CompleteAction({
        projectKey,
        customerId,
        complete: !state.manual_complete,
      });
      setState(res.state);
      setFlash(res.message);
    });
  };

  return (
    <div className="space-y-3">
      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[1.0625rem] font-medium leading-snug">
              Ordnerstruktur
            </h2>
            <p className="mt-0.5 text-[0.875rem] text-[var(--muted)]">
              Nur Struktur prüfen/anlegen — keine Inhaltsprüfung von RAW-Dateien
            </p>
          </div>
          <StatusStatusButton
            status={foldersTone}
            label={state.folders_ok ? "OK" : "Offen"}
            className="shrink-0 !min-h-0 !px-2 !py-1 !text-[0.8125rem]"
          />
        </div>

        {state.missing_paths.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-[0.875rem] text-[var(--muted)]">
            {state.missing_paths.slice(0, 8).map((p) => (
              <li key={p} className="break-all">
                Fehlt: {p}
              </li>
            ))}
            {state.missing_paths.length > 8 ? (
              <li>… +{state.missing_paths.length - 8} weitere</li>
            ) : null}
          </ul>
        ) : (
          <p className="mt-2 text-[0.9375rem]">
            Erwartete Zonen und RAW-Unterordner sind vorhanden.
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <StatusActionButton
            status="ready"
            label={pending ? "…" : "Ordner anlegen / prüfen"}
            disabled={pending || !canRun}
            onClick={onEnsure}
            className="!min-h-10 !px-3 !py-2 !text-[0.9375rem]"
          />
        </div>
      </section>

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[1.0625rem] font-medium leading-snug">
              Manuell abschließen
            </h2>
            <p className="mt-0.5 text-[0.875rem] text-[var(--muted)]">
              Erst wenn die Ordnerstruktur stimmt — schaltet Stufe 3 frei
            </p>
          </div>
          <StatusStatusButton
            status={done ? "success" : "ready"}
            label={done ? "Erledigt" : "Offen"}
            className="shrink-0 !min-h-0 !px-2 !py-1 !text-[0.8125rem]"
          />
        </div>
        <div className="mt-3">
          <StatusActionButton
            status={state.manual_complete ? "success" : "ready"}
            label={
              pending
                ? "…"
                : state.manual_complete
                  ? "Abschluss zurücknehmen"
                  : "Stufe 2 abschließen"
            }
            disabled={pending || !canRun || (!state.folders_ok && !state.manual_complete)}
            onClick={onConfirm}
            className="!min-h-10 !px-3 !py-2 !text-[0.9375rem]"
          />
        </div>
      </section>

      {flash ? (
        <p className="text-[0.9375rem] text-[var(--muted)]" role="status">
          {flash}
        </p>
      ) : null}
    </div>
  );
}
