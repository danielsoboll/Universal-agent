import Link from "next/link";

const STEP_LABELS = [
  "Projekt",
  "Ziele",
  "Adapter",
  "Konfiguration",
  "Import",
] as const;

export function SetupStepNav({
  step,
  customerId,
}: {
  step: number;
  customerId?: string | null;
}) {
  const current = Math.min(Math.max(step, 1), 5);

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">
        Schritt {current} von 5
        <span className="muted font-normal"> · {STEP_LABELS[current - 1]}</span>
      </p>
      <ol
        className="grid grid-cols-5 gap-1 sm:gap-1.5"
        aria-label="Setup-Schritte"
      >
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const done = n < current;
          const active = n === current;
          // Zurück und aktueller Schritt ok; Zukunftsschritte nur über Formular-„Weiter“
          // (sonst werden Ziele/Adapter nicht gespeichert).
          const clickable =
            n === 1 || (Boolean(customerId) && n <= current);
          const href = clickable
            ? customerId
              ? `/admin/setup?customer=${customerId}&step=${n}`
              : `/admin/setup?step=1`
            : null;

          const classes = [
            "flex min-h-11 flex-col items-center justify-center rounded-lg border px-1 py-1 text-center text-xs font-medium leading-tight transition-colors sm:min-h-12 sm:px-2 sm:text-sm",
            active
              ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]"
              : done && clickable
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] hover:brightness-95"
                : clickable
                  ? "border-[var(--border)] bg-[var(--panel)] text-[var(--foreground)] hover:border-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--surface-raised)] text-[var(--muted)] opacity-70",
          ].join(" ");

          const inner = (
            <>
              <span className="block">{n}</span>
              <span className="mt-0.5 hidden truncate sm:block">{label}</span>
            </>
          );

          return (
            <li key={n}>
              {href ? (
                <Link
                  href={href}
                  prefetch
                  className={`block ${classes}`}
                  aria-current={active ? "step" : undefined}
                  aria-disabled={!clickable ? true : undefined}
                >
                  {inner}
                </Link>
              ) : (
                <span
                  className={`block ${classes}`}
                  aria-current={active ? "step" : undefined}
                  title={
                    !customerId
                      ? "Zuerst einen Kunden wählen oder anlegen"
                      : "Bitte den aktuellen Schritt speichern (Weiter unten)"
                  }
                >
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
