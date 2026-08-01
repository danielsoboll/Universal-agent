"use client";

import { useState } from "react";
import {
  runControlTablesFahrplanStepAction,
  type FahrplanAccess,
} from "@/actions/controlTablesFahrplan";
import { ControlTablesProgressBar } from "@/components/admin/fahrplan/ControlTablesProgressBar";
import { ControlTablesStepCard } from "@/components/admin/fahrplan/ControlTablesStepCard";
import type { ControlTablesFahrplanState } from "@/lib/rebuild/controlTablesFahrplanTypes";
import {
  FAHRPLAN_STEP_IDS,
  getControlTablesNextAction,
} from "@/lib/rebuild/controlTablesFahrplanTypes";
import { CT_STEP_DISPLAY_TITLE } from "@/components/admin/fahrplan/controlTablesFahrplanUi";
import { StatusStatusButton } from "@/components/admin/fahrplan/CompactStatus";
import { PROJECT_ADMIN_REQUIRED_HINT } from "@/lib/onboarding/permissions";

export function ControlTablesFahrplanView({
  initial,
  access,
  projectKey,
  embedded = false,
}: {
  initial: ControlTablesFahrplanState;
  access: FahrplanAccess;
  projectKey: string;
  /** Nested under a Hauptschritt — no competing page title. */
  embedded?: boolean;
}) {
  const [state, setState] = useState(initial);
  const [flash, setFlash] = useState<string | null>(null);

  const onRun = async (stepId: number) => {
    setFlash(null);
    setState((prev) => {
      const id = stepId as keyof typeof prev.steps;
      if (!(id in prev.steps)) return prev;
      return {
        ...prev,
        overall: "processing",
        steps: {
          ...prev.steps,
          [id]: {
            ...prev.steps[id],
            status: "running" as const,
          },
        },
      };
    });
    const res = await runControlTablesFahrplanStepAction({
      projectKey,
      stepId,
    });
    setState(res.state);
    setFlash(res.message);
  };

  const next = getControlTablesNextAction(state);
  const currentStep =
    next.stepId != null ? state.steps[next.stepId] : null;
  const allDone = next.done || state.overall === "completed";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2.5 sm:space-y-4">
      {embedded ? null : (
        <header>
          <h1 className="admin-page-title">Datenimport</h1>
        </header>
      )}

      <ControlTablesProgressBar steps={state.steps} />

      {flash ? (
        <p
          className={`text-[1rem] ${
            flash === PROJECT_ADMIN_REQUIRED_HINT
              ? "text-[var(--warning)]"
              : "text-[var(--muted)]"
          }`}
          role="status"
        >
          {flash}
        </p>
      ) : null}

      {allDone ? (
        <article className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3 sm:rounded-2xl sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="admin-card-title min-w-0 font-medium tracking-tight">
              Suche testen
            </h2>
            <StatusStatusButton
              status="success"
              label="OK"
              className="!min-h-0 !px-2 !py-1 !text-[0.8125rem]"
            />
          </div>
        </article>
      ) : null}

      {currentStep && !next.done ? (
        <ControlTablesStepCard
          step={currentStep}
          canRun={access.canRun}
          showTechDetails={access.showTechDetails}
          onRun={onRun}
          variant="current"
        />
      ) : null}

      <section aria-label="Alle technischen Schritte">
        <h2 className="mb-2 text-sm font-medium text-[var(--muted)]">
          Schritte
        </h2>
        <ol className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {FAHRPLAN_STEP_IDS.map((id) => (
            <ControlTablesStepCard
              key={id}
              step={state.steps[id]}
              canRun={access.canRun}
              showTechDetails={access.showTechDetails}
              onRun={onRun}
              variant="row"
            />
          ))}
        </ol>
        {currentStep && !next.done ? (
          <p className="sr-only">
            Aktion für „{CT_STEP_DISPLAY_TITLE[currentStep.id]}“ oben in der
            Aktionskarte.
          </p>
        ) : null}
      </section>

      <details className="text-sm text-[var(--muted)]">
        <summary className="cursor-pointer font-medium hover:text-[var(--foreground)]">
          Technische Details
        </summary>
        <dl className="mt-2 space-y-1 font-mono text-xs">
          <div className="flex flex-wrap gap-x-2">
            <dt>Projekt</dt>
            <dd className="break-all">{projectKey}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>Typ</dt>
            <dd>control-tables</dd>
          </div>
          {access.roleLabel ? (
            <div className="flex flex-wrap gap-x-2">
              <dt>Rolle</dt>
              <dd>{access.roleLabel}</dd>
            </div>
          ) : null}
        </dl>
      </details>
    </div>
  );
}
