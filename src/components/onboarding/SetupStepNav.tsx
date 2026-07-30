import Link from "next/link";

const STEP_LABELS = [
  "Kunde",
  "Ziele",
  "Adapter",
  "Konfiguration",
  "Fahrplan",
] as const;

export function SetupStepNav({
  step,
  customerId,
}: {
  step: number;
  customerId?: string | null;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">
        Schritt {Math.min(Math.max(step, 1), 5)} von 5
        <span className="muted font-normal">
          {" "}
          · {STEP_LABELS[Math.min(Math.max(step, 1), 5) - 1]}
        </span>
      </p>
      <ol className="grid grid-cols-5 gap-1.5 sm:gap-2" aria-label="Setup-Schritte">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          const active = n === step;
          const locked = n > step || (n > 1 && !customerId && n !== 1);
          const href =
            customerId && (done || active)
              ? `/admin/setup?customer=${customerId}&step=${n}`
              : null;

          const classes = [
            "rounded-lg border px-1 py-2 text-center text-[0.65rem] font-semibold leading-tight sm:px-2 sm:text-xs",
            active
              ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]"
              : done
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                : locked
                  ? "border-[var(--border)] bg-[var(--surface-raised)] text-[var(--muted)] opacity-80"
                  : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]",
          ].join(" ");

          const inner = (
            <>
              <span className="block">{n}</span>
              <span className="mt-0.5 hidden sm:block">{label}</span>
            </>
          );

          return (
            <li key={n}>
              {href ? (
                <Link href={href} className={`block ${classes}`} aria-current={active ? "step" : undefined}>
                  {inner}
                </Link>
              ) : (
                <span className={`block ${classes}`} aria-current={active ? "step" : undefined}>
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
