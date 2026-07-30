import Link from "next/link";

export function InlineError({
  title = "Etwas ist schiefgelaufen",
  message,
  actionHref,
  actionLabel = "Zurück",
}: {
  title?: string;
  message: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div
      className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm"
      style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
      role="alert"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 opacity-90">{message}</p>
      {actionHref ? (
        <Link href={actionHref} className="btn btn-secondary mt-3 inline-flex">
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  actionHref,
  actionLabel,
}: {
  title: string;
  message: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="panel compact p-4 text-sm">
      <p className="font-semibold">{title}</p>
      <p className="muted mt-1">{message}</p>
      {actionHref && actionLabel ? (
        <Link href={actionHref} className="btn btn-primary mt-3 inline-flex">
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

export function PageError({
  title = "Seite konnte nicht geladen werden",
  message = "Bitte versuchen Sie es erneut. Wenn das Problem bleibt, melden Sie sich ab und wieder an.",
  digest,
}: {
  title?: string;
  message?: string;
  digest?: string;
}) {
  return (
    <main className="page-shell flex min-h-[50vh] items-center justify-center">
      <div className="panel w-full max-w-md space-y-4 p-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="muted text-sm">{message}</p>
        {digest ? (
          <p className="muted text-xs">Referenz: {digest}</p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/" className="btn btn-primary">
            Zur Startseite
          </Link>
          <Link href="/login" className="btn btn-secondary">
            Zur Anmeldung
          </Link>
        </div>
      </div>
    </main>
  );
}

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Wird geladen">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-16 animate-pulse rounded-xl bg-[var(--surface-raised)]"
        />
      ))}
    </div>
  );
}

export function RetryButton({
  onClick,
  label = "Erneut versuchen",
}: {
  onClick?: () => void;
  label?: string;
}) {
  return (
    <button type="button" className="btn btn-secondary" onClick={onClick}>
      {label}
    </button>
  );
}
