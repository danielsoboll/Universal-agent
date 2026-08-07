/**
 * Deterministic ABAP literal extraction for the portable literal-index.
 * Finds literals + technical field binding; does not assert business meaning.
 */
import { createHash } from "crypto";
import type {
  PortableLiteralCandidateRole,
  PortableLiteralRecord,
  PortableLiteralType,
} from "@/lib/portableIndex/literalTypes";

const TECH_FIELDS: Array<{
  field: string;
  role: PortableLiteralCandidateRole;
  re: RegExp;
}> = [
  { field: "MATNR", role: "material_number", re: /\b(?:[A-Z0-9_]+-)?MATNR\b/i },
  { field: "KUNNR", role: "customer_number", re: /\b(?:[A-Z0-9_]+-)?KUNNR\b/i },
  { field: "LIFNR", role: "vendor_number", re: /\b(?:[A-Z0-9_]+-)?LIFNR\b/i },
  { field: "WERKS", role: "plant", re: /\b(?:[A-Z0-9_]+-)?WERKS\b/i },
  { field: "LGORT", role: "storage_location", re: /\b(?:[A-Z0-9_]+-)?LGORT\b/i },
  { field: "VKORG", role: "sales_org", re: /\b(?:[A-Z0-9_]+-)?VKORG\b/i },
  { field: "VTWEG", role: "distr_channel", re: /\b(?:[A-Z0-9_]+-)?VTWEG\b/i },
  { field: "SPART", role: "division", re: /\b(?:[A-Z0-9_]+-)?SPART\b/i },
  { field: "BUKRS", role: "company_code", re: /\b(?:[A-Z0-9_]+-)?BUKRS\b/i },
  { field: "AUART", role: "order_type", re: /\b(?:[A-Z0-9_]+-)?AUART\b/i },
  { field: "BSART", role: "order_type", re: /\b(?:[A-Z0-9_]+-)?BSART\b/i },
  { field: "KSCHL", role: "condition_type", re: /\b(?:[A-Z0-9_]+-)?KSCHL\b/i },
  { field: "MESTYP", role: "message_type", re: /\b(?:[A-Z0-9_]+-)?MESTYP\b/i },
  { field: "IDOCTP", role: "idoc_type", re: /\b(?:[A-Z0-9_]+-)?IDOCTP\b/i },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumberAt(code: string, index: number): number {
  return code.slice(0, Math.max(0, index)).split("\n").length;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith('"');
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

function looksLikeNoiseLiteral(v: string): boolean {
  if (!v || !v.trim() || v.length > 60) return true;
  if (/^(true|false|abap_true|abap_false|x|space|initial|sy-uname|sy-datum)$/i.test(v)) {
    return true;
  }
  if (/^(NAME1|ORT01|ARKTX|ERNAM|ERDAT|AEDAT)$/i.test(v)) return true;
  return false;
}

function normalizeLiteral(raw: string): string {
  const t = raw.trim();
  if (/^\d+$/.test(t)) return t.replace(/^0+(?=\d)/, "") || "0";
  return t.toUpperCase();
}

function isBoundToField(statement: string, lit: string, field: string): boolean {
  const e = escapeRe(lit);
  const f = escapeRe(field);
  const patterns = [
    new RegExp(`\\b(?:[A-Z0-9_]+-)?${f}\\b\\s*(?:=|EQ|NE|CP|IN)\\s*'${e}'`, "i"),
    new RegExp(`'${e}'\\s*(?:=|EQ|NE)\\s*(?:[A-Z0-9_]+-)?${f}\\b`, "i"),
    new RegExp(
      `\\b(?:[A-Z0-9_]+-)?${f}\\b[^.]{0,100}?\\b(?:IN|BETWEEN)\\b[^.]{0,120}?'${e}'`,
      "i",
    ),
    new RegExp(`\\bMOVE\\s+'${e}'\\s+TO\\s+[^.\\n]*\\b${f}\\b`, "i"),
    new RegExp(
      `\\b(?:[A-Z0-9_]*${f}[A-Z0-9_]*)-(?:LOW|HIGH)\\s*=\\s*'${e}'`,
      "i",
    ),
    new RegExp(
      `\\b[A-Z0-9_]*${f}[A-Z0-9_]*\\b[^.\\n]{0,80}?\\bdefault\\s+'${e}'`,
      "i",
    ),
    new RegExp(
      `\\b(?:TYPE|LIKE)\\s+[A-Z0-9_-]*${f}\\b[^.\\n]{0,40}?\\bVALUE\\s+'${e}'`,
      "i",
    ),
    new RegExp(
      `\\blow\\s*=\\s*'${e}'[^.]{0,120}?\\b(?:[A-Z0-9_]*${f})`,
      "i",
    ),
  ];
  return patterns.some((p) => p.test(statement));
}

function contextTokens(statement: string): string[] {
  const out = new Set<string>();
  for (const m of statement.matchAll(/\b([A-Z][A-Z0-9_]{2,30})\b/g)) {
    const t = m[1]!.toUpperCase();
    if (t.length >= 3 && t.length <= 30) out.add(t);
    if (out.size >= 24) break;
  }
  return [...out];
}

function detectBoundFields(statement: string, lit: string): {
  bound_fields: string[];
  candidate_roles: PortableLiteralCandidateRole[];
} {
  const bound_fields: string[] = [];
  const roles = new Set<PortableLiteralCandidateRole>();
  for (const spec of TECH_FIELDS) {
    if (!spec.re.test(statement)) continue;
    if (isBoundToField(statement, lit, spec.field)) {
      bound_fields.push(spec.field);
      roles.add(spec.role);
    }
  }
  return { bound_fields, candidate_roles: [...roles] };
}

function classifyLiteralType(
  lit: string,
  statement: string,
): PortableLiteralType {
  if (/\bCALL\s+FUNCTION\b/i.test(statement) && statement.includes(`'${lit}'`)) {
    return "function_module";
  }
  if (/\bCALL\s+TRANSACTION\b/i.test(statement)) return "transaction";
  if (/\b(?:MESTYP|MESSAGE\s+TYPE)\b/i.test(statement)) return "message_type";
  if (/\bIDOCTP\b/i.test(statement)) return "idoc_type";
  if (/^\d+$/.test(lit)) return "numeric";
  if (lit.length === 1) return "char";
  return "string";
}

function hashUnit(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

export type ExtractLiteralsUnitMeta = {
  project_id: string;
  system_id: string;
  source_key: string;
  source_path: string;
  object_type: string;
  object_name: string;
  program_or_include?: string;
  class_name?: string;
  method_or_routine?: string;
  code_unit_id: string;
};

/**
 * Extract findable literals from one code unit (no full source stored in result).
 */
export function extractLiteralsFromAbap(
  code: string,
  meta: ExtractLiteralsUnitMeta,
): PortableLiteralRecord[] {
  if (!code || code.length < 4) return [];
  const content_hash = hashUnit(code);
  const lines = code.split("\n");
  const out: PortableLiteralRecord[] = [];
  const seen = new Set<string>();
  let seq = 0;

  const push = (
    lit: string,
    idx: number,
    forcedRoles?: PortableLiteralCandidateRole[],
    forcedType?: PortableLiteralType,
  ) => {
    if (looksLikeNoiseLiteral(lit)) return;
    const line_start = lineNumberAt(code, idx);
    const line = lines[line_start - 1] ?? "";
    const in_comment = isCommentLine(line);
    const { text: stmt } = statementAround(code, idx);
    const { bound_fields, candidate_roles } = detectBoundFields(stmt, lit);
    const roles =
      forcedRoles && forcedRoles.length
        ? [...new Set([...candidate_roles, ...forcedRoles])]
        : candidate_roles.length
          ? candidate_roles
          : (["generic_literal"] as PortableLiteralCandidateRole[]);
    const normalized_value = normalizeLiteral(lit);
    const dedupe = `${normalized_value}|${line_start}|${bound_fields.join(",")}|${in_comment ? "c" : "a"}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    seq += 1;
    out.push({
      literal_id: `${meta.code_unit_id}#L${seq}`,
      project_id: meta.project_id,
      system_id: meta.system_id,
      literal_value: lit,
      normalized_value,
      literal_type: forcedType ?? classifyLiteralType(lit, stmt),
      bound_fields,
      context_tokens: contextTokens(stmt),
      candidate_roles: roles,
      object_type: meta.object_type,
      object_name: meta.object_name,
      program_or_include: meta.program_or_include,
      class_name: meta.class_name,
      method_or_routine: meta.method_or_routine,
      code_unit_id: meta.code_unit_id,
      source_key: meta.source_key,
      source_path: meta.source_path,
      line_start,
      line_end: line_start,
      statement_preview: stmt.replace(/\s+/g, " ").trim().slice(0, 220),
      in_comment,
      content_hash,
    });
  };

  // Quoted string literals
  for (const match of code.matchAll(/'([^']{1,60})'/g)) {
    const lit = match[1] ?? "";
    const idx = match.index ?? 0;
    push(lit, idx);
  }

  // CALL FUNCTION '...'
  for (const match of code.matchAll(
    /\bCALL\s+FUNCTION\s+'([^']{1,60})'/gi,
  )) {
    const lit = match[1] ?? "";
    const idx = match.index ?? 0;
    push(lit, idx, ["function_module"], "function_module");
  }

  // CALL TRANSACTION '...'
  for (const match of code.matchAll(
    /\bCALL\s+TRANSACTION\s+'([^']{1,40})'/gi,
  )) {
    const lit = match[1] ?? "";
    const idx = match.index ?? 0;
    push(lit, idx, ["transaction_code"], "transaction");
  }

  // Bare numeric bound to known fields: FIELD EQ 1234
  for (const spec of TECH_FIELDS) {
    const re = new RegExp(
      `\\b(?:[A-Z0-9_]+-)?${spec.field}\\b\\s*(?:EQ|=|NE|IN|CP)\\s+(\\d{2,18})\\b`,
      "gi",
    );
    for (const match of code.matchAll(re)) {
      const lit = match[1] ?? "";
      const idx = match.index ?? 0;
      push(lit, idx, [spec.role], "numeric");
    }
  }

  return out;
}
