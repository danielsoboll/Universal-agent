import Link from "next/link";

/** Einheitliche Zurück-Navigation (Behördenpost-Pattern). */
export function BackNavLink({
  href,
  label = "Zurück",
}: {
  href: string;
  label?: string;
}) {
  return (
    <Link
      href={href}
      className="back-nav-link muted mb-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium transition-colors hover:text-[var(--accent)]"
    >
      <span aria-hidden className="text-base leading-none">
        ←
      </span>
      {label}
    </Link>
  );
}
