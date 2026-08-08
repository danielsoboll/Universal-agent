/**
 * Deterministic presentation hints — same retrieval, different answer priority.
 * No object hardcoding.
 */
import type {
  PresentationHint,
  PresentationHintResult,
} from "@/lib/knowledge/seedEnrichment/types";

const HOW_WORKS_RE =
  /\b(wie\s+funktioniert|wie\s+läuft|wie\s+laeuft|ablauf|mechanismus|was\s+passiert|prozess)\b/i;
const WHERE_USED_RE =
  /\b(wo\s+wird|wo\s+steht|verwendet|benutz|aufruf|usage|verwendet\s+wird|welche\s+(programme|klassen|methoden))\b/i;
const WHICH_INSTANCES_RE =
  /\b(welche\s+kunden|welche\s+lieferanten|welche\s+materialien|wer\s+hat|bei\s+welchen|gesetzt|aktiv)\b/i;

export function classifyPresentationHint(
  question: string,
): PresentationHintResult {
  const q = question.trim();
  const signals: string[] = [];
  let hint: PresentationHint = "generic";

  if (HOW_WORKS_RE.test(q)) {
    hint = "how_works";
    signals.push("how_works");
  } else if (WHERE_USED_RE.test(q)) {
    hint = "where_used";
    signals.push("where_used");
  } else if (WHICH_INSTANCES_RE.test(q)) {
    hint = "which_instances";
    signals.push("which_instances");
  }

  return { hint, signals };
}
