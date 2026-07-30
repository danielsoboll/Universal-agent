import type { UiGuideText } from "@/lib/onboarding/uiGuideTexts";

/** Compact “Was ist zu tun?” hint from Supabase, shown beside actions. */
export function ActionGuide({
  guide,
  className = "",
}: {
  guide?: UiGuideText | null;
  className?: string;
}) {
  if (!guide) return null;
  return (
    <aside
      className={`rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] px-3 py-2 text-sm ${className}`}
      aria-label={guide.title}
    >
      <p className="font-semibold text-[var(--accent)]">{guide.title}</p>
      <p className="muted mt-1 leading-relaxed">{guide.body}</p>
    </aside>
  );
}

export function ActionWithGuide({
  guide,
  children,
  className = "",
}: {
  guide?: UiGuideText | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 sm:flex-row sm:items-start ${className}`}>
      <div className="shrink-0">{children}</div>
      <ActionGuide guide={guide} className="min-w-0 flex-1" />
    </div>
  );
}
