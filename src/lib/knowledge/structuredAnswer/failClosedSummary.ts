/**
 * Fail-closed summary when evidence is incomplete.
 */
import type { StructuredClaim } from "./types";

export function buildFailClosedSummary(params: {
  sufficient: boolean;
  base_summary: string;
  confirmed: StructuredClaim[];
  missing: string[];
  answer_type: string;
}): string {
  const confirmedTexts = params.confirmed
    .slice(0, 3)
    .map((c) => c.claim_text.replace(/^Ableitung:\s*/i, ""))
    .filter(Boolean);
  const missing = params.missing.filter(Boolean);

  if (params.sufficient && params.base_summary.trim()) {
    return params.base_summary.trim();
  }

  const parts: string[] = [];
  if (confirmedTexts.length > 0) {
    parts.push(
      `Im aktuellen Datenbestand ist sicher belegt, dass ${confirmedTexts.join("; ")}.`,
    );
  } else {
    parts.push(
      `Im aktuellen Datenbestand konnte für diese ${params.answer_type}-Frage noch keine belastbare Kernaussage bestätigt werden.`,
    );
  }

  if (missing.length > 0) {
    parts.push(`Noch nicht belegt ist: ${missing.slice(0, 4).join("; ")}.`);
    parts.push(
      `Für eine vollständige Antwort fehlt: ${missing.slice(0, 4).join("; ")}.`,
    );
  } else if (!params.sufficient) {
    parts.push(
      "Für eine vollständige Antwort fehlt weitere belegte Evidenz aus Canonical-/Codequellen.",
    );
  }

  return parts.join(" ");
}
