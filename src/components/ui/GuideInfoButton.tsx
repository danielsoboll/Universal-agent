"use client";

import { useState } from "react";
import { InfoIconButton } from "@/components/ui/InfoIconButton";
import {
  InfoSheet,
  type InfoSheetSection,
} from "@/components/ui/InfoSheet";

/** Info-Button + Sheet — für Schritt-Guides, Ziele, Adapter usw. */
export function GuideInfoButton({
  title,
  body,
  sections,
  label,
}: {
  title: string;
  body?: string;
  sections?: InfoSheetSection[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasContent =
    Boolean(body?.trim()) ||
    Boolean(sections?.some((s) => s.text.trim()));
  if (!hasContent) return null;

  return (
    <>
      <InfoIconButton
        label={label ?? `Info: ${title}`}
        onClick={() => setOpen(true)}
      />
      <InfoSheet
        open={open}
        title={title}
        body={body}
        sections={sections}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
