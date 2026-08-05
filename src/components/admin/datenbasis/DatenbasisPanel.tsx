"use client";

import type { DatenbasisTypeCard } from "@/lib/admin/datenbasis/types";
import { StatusStatusButton } from "@/components/admin/fahrplan/CompactStatus";
import type { FahrplanStepStatus } from "@/lib/rebuild/controlTablesFahrplanTypes";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";

function overallTone(
  card: DatenbasisTypeCard,
): FahrplanStepStatus {
  if (!card.unlocked || card.overall === "locked") return "not_available";
  if (card.overall === "approved") return "success";
  if (card.overall === "failed") return "failed";
  if (card.overall === "in_progress" || card.overall === "awaiting_approval") {
    return "running";
  }
  if (card.implementation === "prepared") return "ready";
  return "ready";
}

function overallLabel(card: DatenbasisTypeCard): string {
  if (!card.unlocked || card.overall === "locked") return "Gesperrt";
  switch (card.overall) {
    case "approved":
      return "Freigegeben";
    case "failed":
      return "Fehler";
    case "awaiting_approval":
      return "Freigabe";
    case "in_progress":
      return "In Arbeit";
    case "not_started":
      return "Bereit";
    default:
      return "Gesperrt";
  }
}

export function DatenbasisPanel({
  types,
}: {
  types: DatenbasisTypeCard[];
}) {
  return (
    <div className="space-y-2">
      <p className="text-[0.875rem] font-medium text-[var(--muted)]">
        Exporttypen (Reihenfolge verbindlich)
      </p>
      <ul className="space-y-2">
        {types.map((t) => (
          <li key={t.id}>
            <PressNavigateLink
              href={t.href}
              className="admin-card block rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3 transition-opacity hover:opacity-95"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[1.0625rem] font-medium leading-snug break-words">
                    {t.orderIndex + 1}. {t.title}
                  </p>
                  <p className="mt-0.5 text-[0.8125rem] leading-snug text-[var(--muted)] break-words">
                    {t.description}
                  </p>
                  <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">
                    {t.nextActionLabel}
                    {t.rawFolder ? ` · ${t.rawFolder}` : ""}
                    {t.certainty !== "verified"
                      ? ` · ${t.certainty}`
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusStatusButton
                    status={overallTone(t)}
                    label={overallLabel(t)}
                    className="!min-h-0 !px-2 !py-1 !text-[0.8125rem]"
                  />
                  <span className="text-[0.75rem] tabular-nums text-[var(--muted)]">
                    {t.progressPercent}&nbsp;%
                  </span>
                </div>
              </div>
            </PressNavigateLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
