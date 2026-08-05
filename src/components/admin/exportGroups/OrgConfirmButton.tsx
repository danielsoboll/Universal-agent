"use client";

import { useState, useTransition } from "react";
import { confirmExportGroupOrgPointAction } from "@/actions/exportGroups";
import { StatusActionButton } from "@/components/admin/fahrplan/CompactStatus";
import { PROJECT_ADMIN_REQUIRED_HINT } from "@/lib/onboarding/permissions";

/** Manual org confirmation for Area 3 flow points. */
export function OrgConfirmButton({
  projectKey,
  groupId,
  pointKey,
  confirmed,
  canRun,
  label = "Bestätigen",
}: {
  projectKey: string;
  groupId: string;
  pointKey: string;
  confirmed: boolean;
  canRun: boolean;
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(confirmed);

  const onToggle = () => {
    if (!canRun) {
      setFlash(PROJECT_ADMIN_REQUIRED_HINT);
      return;
    }
    setFlash(null);
    startTransition(async () => {
      const res = await confirmExportGroupOrgPointAction({
        projectKey,
        groupId,
        key: pointKey,
        confirmed: !isDone,
      });
      if (res.ok) {
        setIsDone(!isDone);
      }
      setFlash(res.message);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <StatusActionButton
        status={isDone ? "success" : "ready"}
        label={
          pending ? "…" : isDone ? "Bestätigt" : label
        }
        disabled={pending || !canRun}
        onClick={onToggle}
        className="!min-h-0 !px-2 !py-1 !text-[0.8125rem]"
      />
      {flash ? (
        <p className="text-[0.75rem] text-[var(--muted)]">{flash}</p>
      ) : null}
    </div>
  );
}
