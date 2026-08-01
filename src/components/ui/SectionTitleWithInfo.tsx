import { GuideInfoButton } from "@/components/ui/GuideInfoButton";
import type { UiGuideText } from "@/lib/onboarding/uiGuideTexts";
import type { InfoSheetSection } from "@/components/ui/InfoSheet";

/** Überschrift mit optionalem Info-Button rechts. */
export function SectionTitleWithInfo({
  title,
  subtitle,
  guide,
  infoTitle,
  infoBody,
  infoSections,
  as: Tag = "h2",
}: {
  title: string;
  subtitle?: string;
  guide?: UiGuideText | null;
  infoTitle?: string;
  infoBody?: string;
  infoSections?: InfoSheetSection[];
  as?: "h1" | "h2" | "h3";
}) {
  const sheetTitle = infoTitle ?? guide?.title ?? title;
  const sheetBody = infoBody ?? guide?.body;
  const showInfo =
    Boolean(sheetBody?.trim()) ||
    Boolean(infoSections?.some((s) => s.text.trim()));

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Tag
          className={
            Tag === "h1"
              ? "admin-page-title"
              : "text-xl font-semibold tracking-tight sm:text-[1.375rem]"
          }
        >
          {title}
        </Tag>
        {subtitle ? (
          <p className="muted mt-1 text-sm">{subtitle}</p>
        ) : null}
      </div>
      {showInfo ? (
        <GuideInfoButton
          title={sheetTitle}
          body={sheetBody}
          sections={infoSections}
        />
      ) : null}
    </div>
  );
}
