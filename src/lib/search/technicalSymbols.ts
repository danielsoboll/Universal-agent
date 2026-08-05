/**
 * Extract technical SAP-like symbols from free-text questions.
 * Generic — no customer names hardcoded.
 */
export type TechnicalSymbolKind =
  | "zy_name"
  | "compound_field"
  | "uppercase_token"
  | "method_path";

export type TechnicalSymbol = {
  raw: string;
  norm: string;
  kind: TechnicalSymbolKind;
};

const STOP = new Set(
  [
    "SAP",
    "ABAP",
    "API",
    "HTTP",
    "JSON",
    "XML",
    "PDF",
    "CSV",
    "URL",
    "ID",
    "UUID",
    "OK",
    "YES",
    "NO",
    "NULL",
    "TRUE",
    "FALSE",
    "SELECT",
    "FROM",
    "WHERE",
    "INTO",
    "TYPE",
    "DATA",
    "TABLE",
    "CLASS",
    "METHOD",
    "FUNCTION",
    "REPORT",
    "INCLUDE",
    "FORM",
    "ENDFORM",
    "ENDIF",
    "ELSE",
    "LOOP",
    "ENDLOOP",
    "APPEND",
    "CLEAR",
    "MOVE",
    "CALL",
    "EXPORT",
    "IMPORT",
    "READ",
    "WRITE",
    "CHECK",
    "MESSAGE",
    "RAISE",
    "RETURN",
  ].map((s) => s.toUpperCase()),
);

/**
 * Technical tokens: Z/Y/ZZ names, TABLE-FIELD compounds, CLASS=>METHOD,
 * and uppercase alnum tokens with digits or length ≥4.
 */
export function extractTechnicalSymbols(text: string): TechnicalSymbol[] {
  const out = new Map<string, TechnicalSymbol>();
  const add = (raw: string, kind: TechnicalSymbolKind) => {
    const trimmed = raw.trim();
    if (trimmed.length < 2) return;
    const norm = trimmed.toUpperCase();
    if (STOP.has(norm)) return;
    if (!out.has(norm)) out.set(norm, { raw: trimmed, norm, kind });
  };

  const q = text ?? "";

  // CLASS=>METHOD or CLASS->METHOD
  for (const m of q.matchAll(
    /\b([A-Z][A-Z0-9_/]{2,})\s*(?:=>|->)\s*([A-Z][A-Z0-9_~/]{2,})\b/g,
  )) {
    add(m[0]!, "method_path");
    add(m[1]!, "uppercase_token");
    add(m[2]!, "uppercase_token");
  }

  // TABLE-FIELD / TABLE.FIELD
  for (const m of q.matchAll(
    /\b([A-Z][A-Z0-9_]{2,})\s*[-.]\s*([A-Z][A-Z0-9_]{2,})\b/g,
  )) {
    add(`${m[1]}-${m[2]}`, "compound_field");
    add(m[1]!, "uppercase_token");
    add(m[2]!, "uppercase_token");
  }

  // Z/Y/ZZ/YY names (also lowercase z_/y_ in questions)
  for (const m of q.matchAll(/\b([ZzYy]{1,2}_?[A-Za-z0-9_]{2,})\b/g)) {
    add(m[1]!, "zy_name");
  }

  // Uppercase runs with optional digits/underscores (min length 3 if digit, else 4)
  for (const m of q.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
    const tok = m[1]!;
    if (/\d/.test(tok) || tok.length >= 4) add(tok, "uppercase_token");
  }

  // Mixed tokens that look technical: zFoo → ZFOO if mostly letters and short
  for (const m of q.matchAll(/\b([A-Za-z][A-Za-z0-9_]{2,})\b/g)) {
    const tok = m[1]!;
    if (/^[ZzYy]/.test(tok) && /[A-Z0-9_]/.test(tok.slice(1))) {
      add(tok, "zy_name");
    }
  }

  return [...out.values()].sort((a, b) => b.norm.length - a.norm.length);
}

export function technicalSymbolNeedles(symbols: TechnicalSymbol[]): string[] {
  return [...new Set(symbols.map((s) => s.norm))];
}

/** Case-insensitive substring match of any needle in haystack. */
export function haystackMatchesSymbol(
  haystack: string,
  symbolNorm: string,
): boolean {
  if (!haystack || symbolNorm.length < 2) return false;
  return haystack.toUpperCase().includes(symbolNorm);
}

export function documentSymbolHaystack(doc: {
  title?: string;
  search_text?: string;
  source_key?: string;
  object_name?: string;
  subobject_name?: string;
  tables_read?: string[];
  tables_written?: string[];
  called_functions?: string[];
  called_methods?: string[];
  hardcoded_values?: string[];
  facts?: string[];
  technical_summary?: string;
  business_purpose?: string;
  entities?: Array<{ name?: string; normalized?: string }>;
  evidence?: Array<{ text?: string; lines?: Array<{ quote?: string }> }>;
}): string {
  const parts: string[] = [
    doc.title ?? "",
    doc.search_text ?? "",
    doc.source_key ?? "",
    doc.object_name ?? "",
    doc.subobject_name ?? "",
    doc.technical_summary ?? "",
    doc.business_purpose ?? "",
    ...(doc.tables_read ?? []),
    ...(doc.tables_written ?? []),
    ...(doc.called_functions ?? []),
    ...(doc.called_methods ?? []),
    ...(doc.hardcoded_values ?? []),
    ...(doc.facts ?? []),
    ...(doc.entities ?? []).flatMap((e) => [e.name ?? "", e.normalized ?? ""]),
  ];
  for (const e of doc.evidence ?? []) {
    if (e.text) parts.push(e.text);
    for (const line of e.lines ?? []) {
      if (line.quote) parts.push(line.quote);
    }
  }
  return parts.join("\n");
}
