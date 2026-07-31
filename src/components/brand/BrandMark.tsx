import Link from "next/link";
import { BRAND_MARK_PATH } from "@/lib/branding";
import { DEFAULT_AGENT_TITLE } from "@/lib/onboarding/appProfileTypes";

export function BrandMark({
  size = 36,
  withName = false,
  href = "/",
  title,
  logoUrl,
  compactName = false,
}: {
  size?: number;
  withName?: boolean;
  href?: string | null;
  title?: string | null;
  logoUrl?: string | null;
  /** On narrow headers: shorten long agent titles */
  compactName?: boolean;
}) {
  const fullName = title?.trim() || DEFAULT_AGENT_TITLE;
  const name =
    compactName && fullName.length > 18
      ? fullName.replace(/\s+Analyse Agent$/i, "").replace(/\s+Agent$/i, "") ||
        fullName
      : fullName;
  const src = logoUrl?.trim() || BRAND_MARK_PATH;

  const mark = (
    <span className="inline-flex min-w-0 items-center gap-2">
      {/* native img: vermeidet Next/Image-SVG-/Query-Probleme in Production */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-[22%] bg-[var(--surface)] object-cover shadow-sm"
        style={{ width: size, height: size }}
      />
      {withName ? (
        <span
          className={`text-base font-semibold tracking-tight sm:text-lg ${
            compactName ? "truncate" : "break-words leading-tight"
          }`}
        >
          {name}
        </span>
      ) : null}
    </span>
  );

  if (!href) return mark;
  return (
    <Link
      href={href}
      className="inline-flex min-w-0 max-w-full items-center"
      aria-label={fullName}
    >
      {mark}
    </Link>
  );
}
