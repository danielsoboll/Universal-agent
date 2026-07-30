import { STEP_STATUS_LABELS } from "@/lib/onboarding/phases";

const COLOR: Record<string, string> = {
  not_started: "bg-slate-100 text-slate-700",
  ready: "bg-emerald-100 text-emerald-800",
  in_progress: "bg-sky-100 text-sky-800",
  waiting_for_input: "bg-amber-100 text-amber-900",
  completed: "bg-green-100 text-green-900",
  skipped: "bg-slate-100 text-slate-500",
  blocked: "bg-orange-100 text-orange-900",
  failed: "bg-red-100 text-red-900",
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
