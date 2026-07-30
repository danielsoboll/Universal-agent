import { STEP_STATUS_LABELS } from "@/lib/onboarding/phases";

const COLOR: Record<string, string> = {
  not_started: "bg-[var(--surface-raised)] text-[var(--muted)]",
  ready: "bg-[var(--accent-soft)] text-[var(--accent)]",
  in_progress: "bg-[var(--accent-soft)] text-[var(--foreground)]",
  waiting_for_input: "bg-[var(--accent-soft)] text-[var(--foreground)]",
  completed: "bg-[var(--accent-soft)] text-[var(--accent)]",
  skipped: "bg-[var(--surface-raised)] text-[var(--muted)]",
  blocked: "bg-[var(--danger-soft)] text-[var(--danger)]",
  failed: "bg-[var(--danger-soft)] text-[var(--danger)]",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${COLOR[status] ?? COLOR.not_started}`}
    >
      {STEP_STATUS_LABELS[status] ?? status}
    </span>
  );
}
