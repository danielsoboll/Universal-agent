/**
 * Extract usable hints from cached class unit analyses (Datenbasis).
 */
export type AnalysisHint = {
  technical_summary: string | null;
  business_purpose: string | null;
  special_cases: string[];
  hardcoded_values: string[];
  tables_read: string[];
  tables_written: string[];
  facts: string[];
  confidence: number | null;
};

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asStringArray(v: unknown, max = 6): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    } else if (item && typeof item === "object" && "text" in item) {
      const t = asString((item as { text?: unknown }).text);
      if (t) out.push(t);
    }
    if (out.length >= max) break;
  }
  return out;
}

export function extractAnalysisHint(
  analysis: Record<string, unknown> | undefined | null,
): AnalysisHint | null {
  if (!analysis) return null;
  const nested =
    analysis.analysis &&
    typeof analysis.analysis === "object" &&
    !Array.isArray(analysis.analysis)
      ? (analysis.analysis as Record<string, unknown>)
      : null;
  const src = nested ?? analysis;

  const technical_summary =
    asString(src.technical_summary) ??
    asString(src.summary) ??
    asString(src.short_summary);
  const business_purpose =
    asString(src.business_purpose_inferred) ??
    asString(src.business_purpose) ??
    asString(src.purpose) ??
    asString(src.business_meaning);

  const special_cases = asStringArray(src.special_cases);
  const hardcoded_values = asStringArray(src.hardcoded_values);
  const tables_read = asStringArray(src.tables_read);
  const tables_written = asStringArray(src.tables_written);
  const facts = asStringArray(src.facts, 4);

  const confRaw = src.confidence;
  const confidence =
    typeof confRaw === "number" && Number.isFinite(confRaw) ? confRaw : null;

  if (
    !technical_summary &&
    !business_purpose &&
    special_cases.length === 0 &&
    facts.length === 0
  ) {
    return null;
  }

  return {
    technical_summary: technical_summary?.slice(0, 400) ?? null,
    business_purpose: business_purpose?.slice(0, 400) ?? null,
    special_cases: special_cases.map((s) => s.slice(0, 200)),
    hardcoded_values: hardcoded_values.map((s) => s.slice(0, 80)),
    tables_read: tables_read.slice(0, 8),
    tables_written: tables_written.slice(0, 8),
    facts: facts.map((s) => s.slice(0, 220)),
    confidence,
  };
}

/** Compact one-liner for occurrence.process_rationale. */
export function analysisHintToRationale(hint: AnalysisHint | null): string | null {
  if (!hint) return null;
  return (
    hint.business_purpose ??
    hint.technical_summary ??
    hint.facts[0] ??
    hint.special_cases[0] ??
    null
  );
}
