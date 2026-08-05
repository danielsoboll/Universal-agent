import { ExportGroupCard } from "@/components/admin/exportGroups/ExportGroupCard";
import { exportGroupDetailHref } from "@/lib/admin/exportGroups/definitions";
import type { ExportGroupState } from "@/lib/admin/exportGroups/types";

/** List of export groups for Hauptschritt 3 / 4 / 5. */
export function ExportGroupsPanel({
  groups,
  stepId,
  customerId,
  mode,
}: {
  groups: ExportGroupState[];
  stepId: 3 | 4 | 5;
  customerId?: string | null;
  mode: "export" | "validation" | "feintuning";
}) {
  const heading =
    mode === "export"
      ? "Exportgruppen"
      : mode === "validation"
        ? "Validierung nach Exportgruppe"
        : "Feintuning nach Exportgruppe";

  return (
    <section className="space-y-2">
      <p className="text-[0.875rem] font-medium text-[var(--muted)]">{heading}</p>
      <ul className="space-y-2">
        {groups.map((group) => (
          <li key={group.id}>
            <ExportGroupCard
              group={group}
              mode={mode}
              href={exportGroupDetailHref(stepId, group.id, customerId)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
