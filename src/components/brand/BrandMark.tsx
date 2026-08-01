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
  /** Slightly smaller type on dense headers — never ellipsis-truncate. */
  compactName?: boolean;
}) {
  const fullName = title?.trim() || DEFAULT_AGENT_TITLE;
  const src = logoUrl?.trim() || BRAND_MARK_PATH;

  const mark = (
    <span className="inline-flex min-w-0 items-center gap-1.5 sm:gap-2">
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
          className={`${
            compactName
              ? "min-w-0 break-words text-[0.8125rem] font-medium leading-snug tracking-tight sm:text-sm"
              : "min-w-0 break-words text-base font-semibold leading-snug tracking-tight sm:text-lg"
          }`}
        >
          {fullName}
        </span>
      ) : null}
    </span>
  );

  if (!href) return mark;
  return (
    <Link
      href={href}
      className="inline-flex min-w-0 items-center"
      aria-label={fullName}
    >
      {mark}
    </Link>
  );
}
