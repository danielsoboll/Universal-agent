/**
 * Deterministic ABAP extracts for programs / function modules.
 * Extends table/call extraction with PERFORM, SUBMIT, INCLUDE, etc.
 * No OpenAI.
 */

import { extractAbapArtifacts, normalizeToken } from "@/lib/analysis/abapExtract";

export type ProgramExtract = {
  tables_read: string[];
  tables_written: string[];
  tables_zy: string[];
  fields: string[];
  call_function: string[];
  call_method: string[];
  perform: string[];
  submit: string[];
  include: string[];
  call_transaction: string[];
  message: string[];
  authority_check: string[];
  hardcoded_values: string[];
};

function stripComments(sourceCode: string): string {
  return sourceCode
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^\s*\*/.test(line)) return "";
      const quote = line.indexOf('"');
      if (quote >= 0) return line.slice(0, quote);
      return line;
    })
    .join("\n");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [
    ...new Set(
      [...values]
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => v.toUpperCase()),
    ),
  ].sort();
}

function uniqueSortedPreserve(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const key = t.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()));
}

/** Field refs we are sure about: tab-field / struct-field with ABAP name chars. */
function extractSureFields(code: string): string[] {
  const fields = new Set<string>();
  for (const match of code.matchAll(
    /\b([\/A-Za-z_][\/A-Za-z0-9_]{1,30})-([\/A-Za-z_][\/A-Za-z0-9_]{1,30})\b/g,
  )) {
    const left = normalizeToken(match[1] ?? "");
    const right = normalizeToken(match[2] ?? "");
    if (!left || !right) continue;
    // Skip obvious non-fields
    if (
      /^(IF|EQ|NE|LT|GT|LE|GE|AND|OR|NOT|IS|TO|BY|IN|FOR|FROM|INTO)$/.test(left)
    ) {
      continue;
    }
    if (right.length < 2) continue;
    fields.add(`${left}-${right}`);
  }
  return [...fields].sort();
}

/** Conservative hardcoded literals: quoted strings ≥2 chars, not empty/space. */
function extractHardcoded(code: string): string[] {
  const values = new Set<string>();
  for (const match of code.matchAll(/'([^']{2,80})'/g)) {
    const v = match[1] ?? "";
    if (!v.trim()) continue;
    // Skip ABAP message class style single letters often
    if (/^[\s.]+$/.test(v)) continue;
    values.add(v);
  }
  // Limit explosion on huge programs
  return [...values].sort().slice(0, 500);
}

export function extractProgramArtifacts(sourceCode: string): ProgramExtract {
  const base = extractAbapArtifacts(sourceCode);
  const code = stripComments(sourceCode);

  const perform = new Set<string>();
  for (const match of code.matchAll(
    /\bPERFORM\s+([\/A-Za-z_][\/A-Za-z0-9_]*)/gi,
  )) {
    perform.add(normalizeToken(match[1] ?? ""));
  }

  const submit = new Set<string>();
  for (const match of code.matchAll(
    /\bSUBMIT\s+([\/A-Za-z_][\/A-Za-z0-9_]*)/gi,
  )) {
    submit.add(normalizeToken(match[1] ?? ""));
  }

  const include = new Set<string>();
  for (const match of code.matchAll(
    /\bINCLUDE\s+([\/A-Za-z_%][\/A-Za-z0-9_%]*)/gi,
  )) {
    include.add(normalizeToken(match[1] ?? ""));
  }

  const callTransaction = new Set<string>();
  for (const match of code.matchAll(
    /\bCALL\s+TRANSACTION\s+'([^']+)'/gi,
  )) {
    callTransaction.add(normalizeToken(match[1] ?? ""));
  }
  for (const match of code.matchAll(
    /\bCALL\s+TRANSACTION\s+([\/A-Za-z_][\/A-Za-z0-9_]*)/gi,
  )) {
    callTransaction.add(normalizeToken(match[1] ?? ""));
  }

  const message = new Set<string>();
  for (const match of code.matchAll(
    /\bMESSAGE\s+(?:ID\s+'([^']+)'\s+TYPE\s+'([^']+)'\s+NUMBER\s+'?(\d+)'?|([IESWX])(\d{3})\s*\(([^)]+)\))/gi,
  )) {
    if (match[1] && match[2] && match[3]) {
      message.add(`${match[2].toUpperCase()}${match[3]}(${match[1].toUpperCase()})`);
    } else if (match[4] && match[5] && match[6]) {
      message.add(
        `${match[4].toUpperCase()}${match[5]}(${match[6].toUpperCase()})`,
      );
    }
  }
  // MESSAGE e001 / MESSAGE 'text' TYPE 'E'
  for (const match of code.matchAll(
    /\bMESSAGE\s+([ieswx])(\d{3})\b/gi,
  )) {
    message.add(`${match[1]!.toUpperCase()}${match[2]}`);
  }

  const authority = new Set<string>();
  for (const match of code.matchAll(
    /\bAUTHORITY-CHECK\s+OBJECT\s+'([^']+)'/gi,
  )) {
    authority.add(normalizeToken(match[1] ?? ""));
  }

  const tablesZy = uniqueSorted(
    [...base.tables_read, ...base.tables_written].filter((t) =>
      /^[ZY]/.test(t),
    ),
  );

  return {
    tables_read: base.tables_read,
    tables_written: base.tables_written,
    tables_zy: tablesZy,
    fields: extractSureFields(code),
    call_function: base.called_functions,
    call_method: base.called_methods,
    perform: uniqueSorted(perform),
    submit: uniqueSorted(submit),
    include: uniqueSorted(include),
    call_transaction: uniqueSorted(callTransaction),
    message: uniqueSorted(message),
    authority_check: uniqueSorted(authority),
    hardcoded_values: uniqueSortedPreserve(extractHardcoded(code)),
  };
}
