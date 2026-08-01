import type { UiGuideText } from "@/lib/onboarding/uiGuideTexts";
import { GuideInfoButton } from "@/components/ui/GuideInfoButton";

/**
 * @deprecated Inline-Hinweis — bitte SectionTitleWithInfo / GuideInfoButton nutzen.
 * Bleibt nur als Fallback für Seiten ohne Umbau.
 */
export function ActionGuide({
  guide,
  className = "",
}: {
  guide?: UiGuideText | null;
  className?: string;
}) {
  if (!guide) return null;
  return (
    <div className={`flex justify-end ${className}`}>
      <GuideInfoButton title={guide.title} body={guide.body} />
    </div>
  );
}

/** Aktion + Info-Button (ohne langen Textblock daneben). */
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
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {children}
      {guide ? (
        <GuideInfoButton title={guide.title} body={guide.body} />
      ) : null}
    </div>
  );
}
