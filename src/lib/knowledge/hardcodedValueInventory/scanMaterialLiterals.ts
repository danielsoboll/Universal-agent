/**
 * Deterministic scan for hardcoded MATERIAL_NUMBER candidates in ABAP source.
 * Requires the literal to be bound to MATNR (not merely co-occurring in a statement).
 */

export type RawLiteralHit = {
  original_literal: string;
  material_number: string;
  material_number_internal: string;
  line_number: number | null;
  snippet: string;
  condition: string | null;
  action: string | null;
  tables_fields: string[];
  active_code: boolean;
  comment_only: boolean;
  confidence: number;
  exclude_reason: string | null;
};

const MATNR_FIELD_RE =
  /\b(?:[A-Z0-9_]+-)?MATNR\b|\bTYPE\s+MATNR\b|\bLIKE\s+[A-Z0-9_]*MATNR\b|\bRANGE\s+OF\s+MATNR\b|\bTR_MATNR\b|\bSR_MATNR\b|\bIR_MATNR\b|\bLT_MATNR\b|\bIT_MATNR\b|\bC_TR_MATNR\b|\bR_MATNR\b/i;

const MATERIAL_SEMANTIC_RE =
  /\b(?:material(?:nummer)?|artikel(?:nummer)?)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumberAt(code: string, index: number): number {
  return code.slice(0, Math.max(0, index)).split("\n").length;
}

function statementAround(
  code: string,
  index: number,
): { start: number; end: number; text: string } {
  let start = index;
  while (start > 0 && code[start - 1] !== "." && code[start - 1] !== "\n") {
    start -= 1;
  }
  let end = index;
  let inQuote = false;
  for (; end < code.length; end++) {
    const ch = code[end]!;
    if (ch === "'") {
      if (inQuote && code[end + 1] === "'") {
        end += 1;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === ".") {
      end += 1;
      break;
    }
  }
  return { start, end, text: code.slice(start, end) };
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith('"');
}

function looksLikeDate(v: string): boolean {
  if (/^(19|20)\d{2}$/.test(v)) return true;
  if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(v)) return true;
  return false;
}

function normalizeMaterial(raw: string): {
  display: string;
  internal: string;
} {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\s+/g, "");
  if (/^\d+$/.test(digits)) {
    return { display: digits, internal: digits };
  }
  return { display: trimmed.toUpperCase(), internal: trimmed.toUpperCase() };
}

/**
 * Shape gate — still requires MATNR binding afterwards.
 */
function isPlausibleMaterialLiteral(raw: string): {
  ok: boolean;
  reason?: string;
} {
  const v = raw.trim();
  if (!v) return { ok: false, reason: "empty" };
  if (v.length > 40) return { ok: false, reason: "too_long" };
  if (looksLikeDate(v)) return { ok: false, reason: "date_or_year" };
  if (/^(true|false|abap_true|abap_false|x|space|initial)$/i.test(v)) {
    return { ok: false, reason: "boolean" };
  }
  // Screen / BDC / DDIC field names, not material values
  if (/-MATNR$/i.test(v) || /-(LOW|HIGH|SIGN|OPTION)$/i.test(v)) {
    return { ok: false, reason: "field_name_literal" };
  }
  if (/^SAP[A-Z0-9_]+$/i.test(v)) {
    return { ok: false, reason: "program_name" };
  }
  if (/^(NAME1|ORT01|KUNNR|LIFNR|WERKS|ARKTX|ERNAM|ERDAT|MATNR)$/i.test(v)) {
    return { ok: false, reason: "ddic_field_name" };
  }
  if (/^0?MATERIAL$/i.test(v)) {
    return { ok: false, reason: "semantic_token" };
  }

  // Pure digits: SAP MATNR-like length 4–18 (leading zeros kept later)
  if (/^\d+$/.test(v)) {
    if (v.length < 4) return { ok: false, reason: "too_short_numeric" };
    if (v.length > 18) return { ok: false, reason: "too_long_numeric" };
    return { ok: true };
  }

  // Alphanumeric customer materials: letter+digit, no separators that look like field paths
  if (/^[A-Z0-9][A-Z0-9]{3,17}$/i.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) {
    return { ok: true };
  }
  return { ok: false, reason: "not_material_shaped" };
}

/**
 * Literal must be an operand of a MATNR comparison / assignment / range / default.
 * Co-occurrence of MATNR elsewhere in a long statement is not enough.
 */
function isLiteralBoundToMatnr(statement: string, lit: string): boolean {
  const e = escapeRe(lit);
  const s = statement;

  // Explicit non-bindings
  if (new RegExp(`\\bFIELDNAME\\s+(?:EQ|=)\\s*'${e}'`, "i").test(s)) {
    return false;
  }
  if (new RegExp(`\\bBDC_FIELD\\s+USING\\s+'${e}'`, "i").test(s)) {
    return false;
  }
  // Condition type / message type etc. as primary left side
  if (
    new RegExp(
      `\\b(?:KSCHL|MSGTY|MSGNO|AUART|BSART|VBTYP|VTWEG|SPART|VKORG)\\b\\s*(?:=|EQ|NE)\\s*'${e}'`,
      "i",
    ).test(s)
  ) {
    return false;
  }
  // Date/number fields defaulting in same SELECT-OPTIONS block — only accept matnr defaults
  if (
    new RegExp(
      `\\b(?:FKDAT|BUDAT|ERDAT|AEDAT|FBUDA|DATUM|DATAB|DATBI)\\b[^.\\n]{0,60}default\\s+'${e}'`,
      "i",
    ).test(s)
  ) {
    return false;
  }

  const positive: RegExp[] = [
    // ls_mara-matnr = '...' / EQ / NE / CP
    new RegExp(
      `\\b(?:[A-Z0-9_]+-)?MATNR\\b\\s*(?:=|EQ|NE|CP|IN)\\s*'${e}'`,
      "i",
    ),
    // '...' = ls_mara-matnr
    new RegExp(`'${e}'\\s*(?:=|EQ|NE)\\s*(?:[A-Z0-9_]+-)?MATNR\\b`, "i"),
    // MATNR IN ( 'a', 'b' ) / BETWEEN
    new RegExp(
      `\\b(?:[A-Z0-9_]+-)?MATNR\\b[^.]{0,100}?\\b(?:IN|BETWEEN)\\b[^.]{0,120}?'${e}'`,
      "i",
    ),
    // MOVE '...' TO ...-matnr
    new RegExp(`\\bMOVE\\s+'${e}'\\s+TO\\s+[^.\\n]*\\bMATNR\\b`, "i"),
    // Range low/high for matnr
    new RegExp(
      `\\b(?:[A-Z0-9_]*MATNR[A-Z0-9_]*|R_MATNR|S_MATNR|IR_MATNR|TR_MATNR|LT_MATNR)-(?:LOW|HIGH)\\s*=\\s*'${e}'`,
      "i",
    ),
    new RegExp(
      `\\b(?:LOW|HIGH)\\s*=\\s*'${e}'[^.]{0,80}?\\b(?:RANGE\\s+OF\\s+MATNR|FOR\\s+[A-Z0-9_]*MATNR)\\b`,
      "i",
    ),
    // APPEND VALUE #( ( sign = 'I' option = 'EQ' low = '...' ) ) TO ...matnr
    new RegExp(
      `\\blow\\s*=\\s*'${e}'[^.]{0,120}?\\b(?:[A-Z0-9_]*MATNR|R_MATNR|S_MATNR)`,
      "i",
    ),
    // PARAMETERS / SELECT-OPTIONS default on matnr
    new RegExp(
      `\\b[A-Z0-9_]*MATNR[A-Z0-9_]*\\b[^.\\n]{0,80}?\\bdefault\\s+'${e}'`,
      "i",
    ),
    new RegExp(
      `\\blike\\s+[A-Z0-9_-]*MATNR\\b[^.\\n]{0,60}?\\bdefault\\s+'${e}'`,
      "i",
    ),
    // CONSTANTS ... TYPE matnr VALUE '...'
    new RegExp(
      `\\b(?:TYPE|LIKE)\\s+[A-Z0-9_-]*MATNR\\b[^.\\n]{0,40}?\\bVALUE\\s+'${e}'`,
      "i",
    ),
    new RegExp(
      `\\bVALUE\\s+'${e}'[^.\\n]{0,40}?\\b(?:TYPE|LIKE)\\s+[A-Z0-9_-]*MATNR\\b`,
      "i",
    ),
  ];
  return positive.some((p) => p.test(s));
}

function extractTablesFields(statement: string): string[] {
  const out = new Set<string>();
  for (const m of statement.matchAll(/\b([A-Z][A-Z0-9_]{1,16}-MATNR)\b/gi)) {
    out.add(m[1]!.toUpperCase());
  }
  if (/\bMATNR\b/i.test(statement)) out.add("MATNR");
  return [...out].slice(0, 8);
}

function inferConditionAction(statement: string): {
  condition: string | null;
  action: string | null;
} {
  const s = statement.replace(/\s+/g, " ").trim();
  let condition: string | null = null;
  let action: string | null = null;
  if (/\bIF\b/i.test(s) || /\bCASE\b/i.test(s) || /\bWHEN\b/i.test(s)) {
    condition = "Vergleich / Verzweigung mit Materialliteral";
  }
  if (/\bEQ\b|\b=\b|\bIN\b|\bCP\b|\bBETWEEN\b|\bNE\b/i.test(s)) {
    condition = condition ?? "Literalvergleich gegen MATNR";
  }
  if (/\bAPPEND\b|\bINSERT\b|\bLOW\b|\bHIGH\b|\bSIGN\b|\bOPTION\b/i.test(s)) {
    action = "Aufnahme in Materialliste / Range";
  } else if (/\bSELECT\b/i.test(s)) {
    action = "Filter in SELECT-Bedingung";
  } else if (/\bDEFAULT\b|\bVALUE\b/i.test(s)) {
    action = "Default-/Konstantenwert für MATNR";
  } else if (/\bMOVE\b|\b=\b/.test(s) && /\bMATNR\b/i.test(s)) {
    action = "Zuweisung an MATNR-Feld / Konstante";
  } else if (/\bCALL\b|\bEXPORTING\b|\bCHANGING\b/i.test(s)) {
    action = "Übergabe an materialbezogenen Parameter";
  } else {
    action = "Verwendung im MATNR-Kontext";
  }
  return { condition, action };
}

export type ScanUnitResult = {
  hits: RawLiteralHit[];
  excluded: Array<{ literal: string; reason: string }>;
  literals_seen: number;
  has_matnr_context: boolean;
};

/**
 * Scan one code unit for hardcoded material-number candidates.
 */
export function scanUnitForMaterialHardcodes(code: string): ScanUnitResult {
  const hits: RawLiteralHit[] = [];
  const excluded: Array<{ literal: string; reason: string }> = [];
  let literals_seen = 0;
  const has_matnr_context = MATNR_FIELD_RE.test(code);
  if (!has_matnr_context && !MATERIAL_SEMANTIC_RE.test(code)) {
    return { hits, excluded, literals_seen, has_matnr_context: false };
  }

  const lines = code.split("\n");
  const seenKeys = new Set<string>();

  for (const match of code.matchAll(/'([^']{1,40})'/g)) {
    const lit = match[1] ?? "";
    const idx = match.index ?? 0;
    literals_seen += 1;
    const lineNo = lineNumberAt(code, idx);
    const line = lines[lineNo - 1] ?? "";
    const comment_only = isCommentLine(line);
    const { text: stmt } = statementAround(code, idx);
    const shape = isPlausibleMaterialLiteral(lit);
    if (!shape.ok) {
      if (excluded.length < 50) {
        excluded.push({ literal: lit, reason: shape.reason ?? "shape" });
      }
      continue;
    }
    if (!isLiteralBoundToMatnr(stmt, lit)) {
      if (excluded.length < 50) {
        excluded.push({ literal: lit, reason: "not_bound_to_matnr" });
      }
      continue;
    }
    const { display, internal } = normalizeMaterial(lit);
    const dedupe = `${internal}|${lineNo}|${comment_only ? "c" : "a"}`;
    if (seenKeys.has(dedupe)) continue;
    seenKeys.add(dedupe);
    const { condition, action } = inferConditionAction(stmt);
    hits.push({
      original_literal: lit,
      material_number: display,
      material_number_internal: internal,
      line_number: lineNo,
      snippet: stmt.replace(/\s+/g, " ").trim().slice(0, 220),
      condition,
      action,
      tables_fields: extractTablesFields(stmt),
      active_code: !comment_only,
      comment_only,
      confidence: comment_only ? 0.4 : 0.92,
      exclude_reason: null,
    });
  }

  // Bare numeric: MATNR EQ 123456 / = 123456
  for (const match of code.matchAll(
    /\b(?:[A-Z0-9_]+-)?MATNR\b\s*(?:EQ|=|NE|IN|CP)\s+(\d{4,18})\b/gi,
  )) {
    const lit = match[1] ?? "";
    literals_seen += 1;
    const idx = match.index ?? 0;
    const lineNo = lineNumberAt(code, idx);
    const line = lines[lineNo - 1] ?? "";
    const comment_only = isCommentLine(line);
    const shape = isPlausibleMaterialLiteral(lit);
    if (!shape.ok) {
      if (excluded.length < 50) {
        excluded.push({ literal: lit, reason: shape.reason ?? "shape" });
      }
      continue;
    }
    const { text: stmt } = statementAround(code, idx);
    const { display, internal } = normalizeMaterial(lit);
    const dedupe = `${internal}|${lineNo}|num|${comment_only ? "c" : "a"}`;
    if (seenKeys.has(dedupe)) continue;
    seenKeys.add(dedupe);
    const { condition, action } = inferConditionAction(stmt);
    hits.push({
      original_literal: lit,
      material_number: display,
      material_number_internal: internal,
      line_number: lineNo,
      snippet: stmt.replace(/\s+/g, " ").trim().slice(0, 220),
      condition,
      action,
      tables_fields: extractTablesFields(stmt),
      active_code: !comment_only,
      comment_only,
      confidence: comment_only ? 0.35 : 0.88,
      exclude_reason: null,
    });
  }

  return {
    hits,
    excluded,
    literals_seen,
    has_matnr_context,
  };
}
