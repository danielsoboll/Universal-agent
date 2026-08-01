/** Display-only labels/tones for Control-Tables Fahrplan UI. */

import type {
  FahrplanOverallStatus,
  FahrplanStepId,
  FahrplanStepStatus,
} from "@/lib/rebuild/controlTablesFahrplanTypes";

/**
 * Full titles for the main action area / list — 1:1 with pipeline steps
 * that the primary buttons execute (not PM/summary wording).
 */
export const CT_STEP_DISPLAY_TITLE: Record<FahrplanStepId, string> = {
  1: "Quelldatei erkennen",
  2: "RAW prüfen",
  3: "Daten konvertieren",
  4: "Konvertierte Daten prüfen",
  5: "Wissensbestand aktualisieren",
  6: "Suche testen",
};

/** Short labels under the compact progress dots only. */
export const CT_STEP_SHORT_LABEL: Record<FahrplanStepId, string> = {
  1: "Quelle",
  2: "Rohdaten",
  3: "Konvertieren",
  4: "Prüfen",
  5: "Wissen",
  6: "Suche",
};

/** Calmer overall labels (avoid oversized „Quellen“ chip feel). */
export const CT_OVERALL_LABEL_DE: Record<FahrplanOverallStatus, string> = {
  not_started: "Nicht gestartet",
  in_review: "In Prüfung",
  processing: "Läuft",
  action_required: "Fehler",
  completed: "Fertig",
};

export type CtTone = {
  symbol: string;
  /** Badge / chip classes (bg + text + ring) */
  badge: string;
  /** Dot fill for progress */
  dot: string;
  /** Connector / muted text tint */
  text: string;
  /** Compact list row background when success */
  row?: string;
};

/** Calm yellow for ready/running — works on light + dark (no orange-brown). */
const YELLOW_BADGE =
  "bg-yellow-400/20 text-yellow-800 ring-yellow-500/35 dark:bg-yellow-400/15 dark:text-yellow-100 dark:ring-yellow-400/40";
const YELLOW_DOT = "bg-yellow-400 dark:bg-yellow-300";
const YELLOW_TEXT = "text-yellow-800 dark:text-yellow-100";

export function ctStepTone(status: FahrplanStepStatus): CtTone {
  switch (status) {
    case "success":
      return {
        symbol: "✓",
        badge:
          "bg-emerald-500/15 text-emerald-800 ring-emerald-500/35 dark:text-emerald-200",
        dot: "bg-emerald-600 dark:bg-emerald-400",
        text: "text-emerald-800 dark:text-emerald-200",
        row: "bg-emerald-500/10",
      };
    case "failed":
      return {
        symbol: "✕",
        badge:
          "bg-[var(--danger-soft)] text-[var(--danger)] ring-[color-mix(in_srgb,var(--danger)_35%,transparent)]",
        dot: "bg-[var(--danger)]",
        text: "text-[var(--danger)]",
      };
    case "running":
      return {
        symbol: "●",
        badge: YELLOW_BADGE,
        dot: YELLOW_DOT,
        text: YELLOW_TEXT,
      };
    case "ready":
      return {
        symbol: "○",
        badge: YELLOW_BADGE,
        dot: YELLOW_DOT,
        text: YELLOW_TEXT,
      };
    default:
      return {
        symbol: "–",
        badge:
          "bg-[var(--surface-raised)] text-[var(--muted)] ring-[var(--border)]",
        dot: "bg-slate-400 dark:bg-slate-500",
        text: "text-[var(--muted)]",
      };
  }
}

export function ctOverallTone(overall: FahrplanOverallStatus): CtTone {
  switch (overall) {
    case "completed":
      return {
        symbol: "✓",
        badge:
          "bg-emerald-500/15 text-emerald-800 ring-emerald-500/35 dark:text-emerald-200",
        dot: "bg-emerald-600",
        text: "text-emerald-800 dark:text-emerald-200",
      };
    case "action_required":
      return {
        symbol: "!",
        badge:
          "bg-[var(--danger-soft)] text-[var(--danger)] ring-[color-mix(in_srgb,var(--danger)_35%,transparent)]",
        dot: "bg-[var(--danger)]",
        text: "text-[var(--danger)]",
      };
    case "processing":
      return {
        symbol: "●",
        badge: YELLOW_BADGE,
        dot: YELLOW_DOT,
        text: YELLOW_TEXT,
      };
    case "in_review":
      return {
        symbol: "○",
        badge: YELLOW_BADGE,
        dot: YELLOW_DOT,
        text: YELLOW_TEXT,
      };
    default:
      return {
        symbol: "–",
        badge:
          "bg-[var(--surface-raised)] text-[var(--muted)] ring-[var(--border)]",
        dot: "bg-slate-400",
        text: "text-[var(--muted)]",
      };
  }
}
