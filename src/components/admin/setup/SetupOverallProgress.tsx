/** Compact overall progress for the project dashboard. */
export function SetupOverallProgress({
  percent,
  doneCount,
  totalCount,
  sentence,
}: {
  percent: number;
  doneCount: number;
  totalCount: number;
  sentence: string;
}) {
  const allDone = doneCount === totalCount;

  return (
    <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3.5 sm:p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[0.9375rem] font-semibold text-[var(--foreground)]">
          Projektstatus
        </p>
        <p className="shrink-0 text-[0.9375rem] tabular-nums text-[var(--muted)]">
          {doneCount}/{totalCount}
        </p>
      </div>
      <div
        className="progress-track mt-2.5 h-2.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Gesamtfortschritt"
      >
        <div
          className={`h-full rounded-full ${
            percent >= 100 ? "progress-fill-done" : "progress-fill"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {allDone ? (
        <p className="mt-2.5 text-[1.125rem] font-medium leading-snug break-words">
          {sentence}
        </p>
      ) : (
        <p className="mt-2.5 leading-snug break-words">
          <span className="text-[1.5rem] font-semibold tabular-nums tracking-tight">
            {percent}&nbsp;%
          </span>
          <span className="text-[0.9375rem] text-[var(--muted)]">
            {" "}
            · {sentence}
          </span>
        </p>
      )}
    </section>
  );
}
