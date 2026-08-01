"use client";

import { useEffect } from "react";

export type InfoSheetSection = {
  heading: string;
  text: string;
};

/** Einfaches Info-Sheet (Bottom/Dialog) — kein Redirect, kein Fake-Content. */
export function InfoSheet({
  open,
  title,
  body,
  sections,
  onClose,
  dismissLabel = "Alles klar",
}: {
  open: boolean;
  title: string;
  body?: string;
  sections?: InfoSheetSection[];
  onClose: () => void;
  dismissLabel?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const visibleSections = (sections ?? []).filter((s) => s.text.trim());

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col justify-end bg-black/40 sm:items-center sm:justify-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-lg sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ga-info-sheet-title"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--border)] sm:hidden" />
        <h2
          id="ga-info-sheet-title"
          className="text-lg font-semibold tracking-tight"
        >
          {title}
        </h2>
        {body?.trim() ? (
          <p className="muted mt-3 text-sm leading-relaxed">{body}</p>
        ) : null}
        {visibleSections.length ? (
          <div className="mt-4 space-y-3">
            {visibleSections.map((s) => (
              <section key={s.heading}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">
                  {s.heading}
                </h3>
                <p className="mt-1 text-sm leading-relaxed">{s.text}</p>
              </section>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn-primary mt-5 w-full"
          onClick={onClose}
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}
