import Image from "next/image";
import Link from "next/link";
import { BRAND_MARK_PATH, getAppIconPath } from "@/lib/branding";
import { DEFAULT_AGENT_TITLE } from "@/lib/onboarding/appProfileTypes";

export function BrandMark({
  size = 36,
  withName = false,
  href = "/",
  title,
  logoUrl,
}: {
  size?: number;
  withName?: boolean;
  href?: string | null;
  title?: string | null;
  logoUrl?: string | null;
}) {
  const name = title?.trim() || DEFAULT_AGENT_TITLE;
  const src = logoUrl?.trim() || BRAND_MARK_PATH;
  const isRemote = Boolean(logoUrl?.startsWith("http"));

  const mark = (
    <span className="inline-flex items-center gap-2.5">
      <Image
        src={isRemote ? logoUrl! : src}
        alt=""
        width={size}
        height={size}
        className="rounded-[22%] bg-[var(--surface)] object-cover shadow-sm"
        unoptimized
        priority
      />
      {withName ? (
        <span className="text-lg font-semibold tracking-tight">{name}</span>
      ) : null}
    </span>
  );

  if (!href) return mark;
  return (
    <Link href={href} className="inline-flex items-center" aria-label={name}>
      {mark}
    </Link>
  );
}

export function BrandIconPreview({ size = 48 }: { size?: number }) {
  return (
    <Image
      src={getAppIconPath(192)}
      alt={DEFAULT_AGENT_TITLE}
      width={size}
      height={size}
      className="rounded-xl object-cover shadow-md"
      priority
    />
  );
}
