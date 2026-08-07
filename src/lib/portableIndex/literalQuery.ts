/**
 * Detect literal / hardcoded-value questions and extract lookup values.
 * Retrieval wiring only — no fachliche Interpretation.
 */
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";

const HARDCODED_CUE_RE =
  /\b(hart\s*codiert|hartcodiert|hard\s*cod(?:ed|ing)?|fest\s*(?:verdrahtet|codiert|im\s+code)|konstanten?|fest\s+im\s+code|stehen\s+fest)\b/i;

/** SAP-ish field name followed by a concrete value. */
const FIELD_VALUE_RE =
  /\b([A-Z][A-Z0-9_]{2,})\s*[=:]?\s*['"]?([A-Z0-9_]{2,}|[0-9]{2,})['"]?/gi;

const STOP_LITERALS = new Set(
  [
    "WO",
    "IST",
    "WIRD",
    "WIRD",
    "STEHT",
    "CODE",
    "FEST",
    "HART",
    "CODERT",
    "IM",
    "DER",
    "DIE",
    "DAS",
    "UND",
    "MIT",
    "VON",
    "AUS",
    "WAS",
    "WELCHE",
    "WELCHER",
  ].map((s) => s.toUpperCase()),
);

export type LiteralQueryDetection = {
  is_literal_query: boolean;
  values: string[];
  /** Optional bound field hints (e.g. VKORG). */
  bound_fields: string[];
  cues: string[];
};

export function detectLiteralQuery(question: string): LiteralQueryDetection {
  const q = question.trim();
  const cues: string[] = [];
  const values = new Set<string>();
  const bound_fields = new Set<string>();

  const hasHard = HARDCODED_CUE_RE.test(q);
  if (hasHard) cues.push("hardcoded_cue");

  FIELD_VALUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIELD_VALUE_RE.exec(q))) {
    const field = m[1]!.toUpperCase();
    const val = m[2]!.trim();
    if (STOP_LITERALS.has(field)) continue;
    if (/^(MATNR|KUNNR|LIFNR|WERKS|VKORG|VTWEG|SPART|BUKRS|LGORT|AUART|KSCHL)$/.test(field)) {
      bound_fields.add(field);
      cues.push(`field:${field}`);
    }
    if (!STOP_LITERALS.has(val.toUpperCase()) && val.length >= 2) {
      values.add(val);
    }
  }

  for (const num of q.matchAll(/\b(\d{3,})\b/g)) {
    values.add(num[1]!);
    cues.push("numeric_literal");
  }

  for (const quoted of q.matchAll(/['"]([^'"]{1,64})['"]/g)) {
    const v = quoted[1]!.trim();
    if (v.length >= 1) values.add(v);
    cues.push("quoted_literal");
  }

  if (hasHard) {
    for (const sym of extractTechnicalSymbols(q)) {
      if (STOP_LITERALS.has(sym.norm)) continue;
      if (sym.kind === "uppercase_token" || /^\d+$/.test(sym.norm)) {
        values.add(sym.raw);
      }
      // Message-/IDoc-Typen u. ä. als Literal-Kandidaten
      if (
        /^(ORDERS|ORDRSP|DESADV|INVOIC|DELVRY|WMMBXY|Z[A-Z0-9]{3,})$/.test(
          sym.norm,
        )
      ) {
        values.add(sym.raw);
      }
    }
  }

  const valueList = [...values].filter((v) => {
    const u = v.toUpperCase();
    return !STOP_LITERALS.has(u) && u.length >= 2;
  });

  const is_literal_query =
    hasHard && valueList.length > 0
      ? true
      : bound_fields.size > 0 && valueList.length > 0 && /fest|hart|code/i.test(q);

  return {
    is_literal_query,
    values: valueList,
    bound_fields: [...bound_fields],
    cues,
  };
}

export function isLiteralHardcodeQuestion(question: string): boolean {
  return detectLiteralQuery(question).is_literal_query;
}
