import { createHash } from "crypto";
import type {
  AnalysisDeviation,
  CodeTableInterpretationRecord,
  ControlTableAnalysisRecord,
} from "@/lib/analysis/controlTablePilotSchema";

export type NumberedLine = { line: number; text: string };

export function splitNumberedLines(sourceCode: string): NumberedLine[] {
  return sourceCode.replace(/\r\n/g, "\n").split("\n").map((text, i) => ({
    line: i + 1,
    text,
  }));
}

export function formatCodeEvidence(line: NumberedLine): string {
  return `L${line.line}|${line.text}`;
}

export function parseCodeEvidence(ev: string): { line: number | null; text: string } {
  const m = /^L(\d+)\|(.*)$/.exec(ev);
  if (!m) return { line: null, text: ev };
  return { line: Number(m[1]), text: m[2] ?? "" };
}

/** Strict: evidence must be L{n}|{exact line text} matching code_units source. */
export function isExactCodeEvidence(
  sourceCode: string,
  evidence: string,
): boolean {
  const lines = splitNumberedLines(sourceCode);
  const parsed = parseCodeEvidence(evidence);
  if (parsed.line == null) return false;
  const hit = lines.find((l) => l.line === parsed.line);
  return hit != null && hit.text === parsed.text;
}

export function findAccessOccurrences(
  sourceCode: string,
  evidenceCode: string,
): NumberedLine[] {
  const lines = splitNumberedLines(sourceCode);
  const needle = evidenceCode.replace(/\s+/g, " ").trim();
  const hits: NumberedLine[] = [];

  // Prefer full single-line SELECT matches
  for (const line of lines) {
    const compact = line.text.replace(/\s+/g, " ").trim();
    if (
      /SELECT/i.test(line.text) &&
      needle &&
      (compact.includes(needle.slice(0, 50)) ||
        (needle.includes("ZEXTO_PARAMETER") &&
          compact.includes("ZEXTO_PARAMETER") &&
          /SELECT/i.test(compact)))
    ) {
      // For ZEXTO SELECT, require KEY01 fragment if present in evidence
      const keyFrag = /KEY01\s+EQ\s+'?[^'\s]+'?/i.exec(needle);
      if (keyFrag && !new RegExp(keyFrag[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(compact)) {
        // multi-line SELECT: KEY01 may be on later line — accept SELECT that starts the block
        const nextBlob = lines
          .slice(line.line - 1, line.line + 5)
          .map((l) => l.text)
          .join(" ");
        if (!new RegExp(keyFrag[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(nextBlob)) {
          continue;
        }
      }
      hits.push(line);
    }
  }

  if (hits.length > 0) return hits;

  // Multi-line: SELECT SINGLE VAL01\n FROM ZEXTO...
  for (const line of lines) {
    if (!/SELECT/i.test(line.text)) continue;
    const blob = lines
      .slice(line.line - 1, line.line + 5)
      .map((l) => l.text.replace(/\s+/g, " "))
      .join(" ");
    if (
      /ZEXTO_PARAMETER/i.test(blob) &&
      /KEY01/i.test(needle) &&
      /KEY01/i.test(blob)
    ) {
      hits.push(line);
    }
  }
  return hits;
}

/**
 * Expand from SELECT (or UPDATE) through related IF/ENDIF usage.
 * Multi-line SELECT: include contiguous SELECT…WHERE block only (no DATA section walk).
 */
export function extractAccessEvidenceWindow(params: {
  sourceCode: string;
  evidenceCode: string;
  occurrenceIndex: number;
  afterRadius?: number;
}): NumberedLine[] {
  const afterRadius = params.afterRadius ?? 14;
  const lines = splitNumberedLines(params.sourceCode);
  const hits = findAccessOccurrences(params.sourceCode, params.evidenceCode).filter(
    (h) => /SELECT|UPDATE/i.test(h.text) || /FROM\s+ZEXTO_PARAMETER/i.test(h.text),
  );
  // Prefer SELECT/UPDATE hits; if evidence matched a mid-block FROM line, climb to SELECT
  let anchor: NumberedLine | undefined =
    hits[params.occurrenceIndex] ??
    hits[0] ??
    lines.find(
      (l) =>
        /SELECT/i.test(l.text) &&
        /ZEXTO_PARAMETER/i.test(params.evidenceCode) &&
        params.sourceCode.includes(l.text),
    );

  if (!anchor) {
    // last resort: first SELECT containing table from evidence
    const tableMatch = /\bFROM\s+([A-Z0-9_/]+)/i.exec(params.evidenceCode);
    const table = tableMatch?.[1]?.toUpperCase();
    anchor = lines.find(
      (l) =>
        /SELECT/i.test(l.text) &&
        (!table ||
          l.text.toUpperCase().includes(table) ||
          lines
            .slice(l.line - 1, l.line + 4)
            .some((x) => x.text.toUpperCase().includes(table ?? ""))),
    );
  }
  if (!anchor) return [];

  let startIdx = anchor.line - 1;
  // Climb to SELECT if anchor is FROM/INTO/WHERE continuation
  if (!/SELECT/i.test(lines[startIdx]!.text)) {
    for (let i = startIdx; i >= Math.max(0, startIdx - 5); i--) {
      if (/SELECT/i.test(lines[i]!.text)) {
        startIdx = i;
        break;
      }
    }
  }
  // Include immediately preceding CLEAR / comment only within 3 lines
  for (let i = 1; i <= 3; i++) {
    const idx = startIdx - i;
    if (idx < 0) break;
    const t = lines[idx]!.text;
    if (/^\s*CLEAR:/i.test(t) || /^\s*"/.test(t) || /^\s*\*/.test(t)) {
      startIdx = idx;
    } else if (t.trim() === "") {
      continue;
    } else {
      break;
    }
  }

  let endIdx = Math.min(lines.length - 1, startIdx + afterRadius);
  // Prefer closing ENDIF after IF that follows SELECT
  let depth = 0;
  let sawIf = false;
  for (let i = startIdx; i < lines.length && i <= startIdx + 40; i++) {
    const t = lines[i]!.text;
    if (/^\s*IF\b/i.test(t)) {
      sawIf = true;
      depth += 1;
    }
    if (/^\s*ENDIF\b/i.test(t) && sawIf) {
      depth -= 1;
      if (depth <= 0) {
        endIdx = i;
        break;
      }
    }
  }

  return lines.slice(startIdx, endIdx + 1);
}

export function buildNumberedSnippet(window: NumberedLine[]): string {
  return window.map((l) => `${String(l.line).padStart(4, " ")}|${l.text}`).join("\n");
}

export function deterministicCodeEvidence(window: NumberedLine[]): string[] {
  return window
    .filter((l) => l.text.trim().length > 0)
    .filter((l) =>
      /SELECT|FROM|INTO|WHERE|IF |ELSE|ENDIF|UPDATE|CLEAR:|EQ |CS |ME->|L_STAT|Z_PARAMN|EXPOR|VAL01|KEY01/i.test(
        l.text,
      ),
    )
    .map(formatCodeEvidence);
}

export function deterministicTableEvidence(row: {
  source_key: string;
  primary_key: Record<string, string>;
  values: Record<string, string>;
}): string[] {
  const out = [`CanonicalTableRow:${row.source_key}`];
  for (const [k, v] of Object.entries(row.primary_key)) {
    out.push(`${k}=${v}`);
  }
  for (const [k, v] of Object.entries(row.values)) {
    if (row.primary_key[k] != null) continue;
    out.push(`${k}=${v}`);
  }
  return out;
}

export function makeAccessId(params: {
  code_source_key: string;
  table_name: string;
  evidence_code: string;
  occurrence_index: number;
  line_start: number;
}): string {
  const raw = [
    params.code_source_key,
    params.table_name,
    params.evidence_code.trim(),
    String(params.occurrence_index),
    String(params.line_start),
  ].join("||");
  return `access:${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Stable business-rule grouping key: same unit + table + resolved key + effect fingerprint.
 * Does not merge records — only adds grouping id.
 */
export function makeBusinessRuleId(params: {
  code_source_key: string;
  table_name: string;
  resolved_key: string;
  effect_fingerprint: string;
}): string {
  const raw = [
    params.code_source_key,
    params.table_name,
    params.resolved_key,
    params.effect_fingerprint,
  ].join("||");
  return `brule:${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16)}`;
}

export function effectFingerprintFromWindow(window: NumberedLine[]): string {
  const texts = window.map((l) => l.text.replace(/\s+/g, " ").trim());
  const parts: string[] = [];
  for (const t of texts) {
    if (/VAL01\s+CS\s+L_INCO1/i.test(t)) parts.push("VAL01_CS_L_INCO1");
    if (/VAL01\s+EQ\s+'X'/i.test(t)) parts.push("VAL01_EQ_X");
    if (/NOT\s+Z_PARAMN\s+CS\s+G_WERKS/i.test(t)) parts.push("NOT_VAL01_CS_G_WERKS");
    if (/SET\s+EXPOR/i.test(t)) parts.push("UPDATE_EXPOR");
    if (/OT_UPDATE_.*TEST/i.test(t)) parts.push("OT_UPDATE_TEST");
    if (/L_STAT\+/i.test(t) && /'J'/i.test(t)) parts.push("L_STAT_J");
  }
  return parts.length ? [...new Set(parts)].sort().join("|") : "read_only";
}

export function countExactCodeEvidence(
  sourceCode: string,
  evidence: string[],
): { exact: number; total: number; bad: string[] } {
  const bad: string[] = [];
  let exact = 0;
  for (const ev of evidence) {
    if (isExactCodeEvidence(sourceCode, ev)) exact += 1;
    else bad.push(ev);
  }
  return { exact, total: evidence.length, bad };
}

export function countExactTableEvidence(
  row: {
    source_key: string;
    primary_key: Record<string, string>;
    values: Record<string, string>;
  },
  evidence: string[],
): { exact: number; total: number; bad: string[] } {
  const allowed = new Set(deterministicTableEvidence(row));
  const rowBlob = JSON.stringify(row);
  const bad: string[] = [];
  let exact = 0;
  for (const ev of evidence) {
    const ok =
      allowed.has(ev) ||
      ev === `CanonicalTableRow:${row.source_key}` ||
      (/^[A-Z0-9_]+=/.test(ev) &&
        (() => {
          const eq = ev.indexOf("=");
          const k = ev.slice(0, eq);
          const v = ev.slice(eq + 1);
          return (
            String(row.primary_key[k] ?? "") === v ||
            String(row.values[k] ?? "") === v
          );
        })()) ||
      rowBlob.includes(ev);
    if (ok) exact += 1;
    else bad.push(ev);
  }
  return { exact, total: evidence.length, bad };
}

const VAGUE_EVIDENCE = new Set([
  "Definition JSON",
  "Tabellenbeschreibung JSON",
  "Tabellenzeilen JSON",
  "Klassifikation JSON",
  "Codeverwendungsnachweise JSON",
  "SAP Standardpraxis",
]);

export function hardenTableAnalysisEvidence(params: {
  record: ControlTableAnalysisRecord;
  definition: { source_key: string; description?: string; table_name: string };
  rows: Array<{ source_key: string; primary_key: Record<string, string>; values: Record<string, string> }>;
  classification?: { classification?: string } | null;
}): {
  record: ControlTableAnalysisRecord;
  facts_without_evidence: string[];
  generalizations: string[];
  changes: string[];
} {
  const changes: string[] = [];
  const facts_without_evidence: string[] = [];
  const generalizations: string[] = [];
  const defRef = `CanonicalTableDefinition:${params.definition.source_key}`;
  const classRef = params.classification?.classification
    ? `CanonicalTableClassification:${params.definition.table_name}:${params.classification.classification}`
    : null;

  const mapEvidence = (ev: string): string => {
    if (VAGUE_EVIDENCE.has(ev) || /^Definition JSON/.test(ev)) {
      changes.push(`vague→${defRef}`);
      return defRef;
    }
    if (/Klassifikation/i.test(ev) && classRef) {
      changes.push(`class→${classRef}`);
      return classRef;
    }
    // Try map "Tabellenzeile mit KEY01=1" style to canonical row
    const km = /KEY01\s*=\s*'?(\d+)'?/i.exec(ev);
    if (km) {
      const row = params.rows.find(
        (r) =>
          String(r.primary_key.KEY01 ?? r.values.KEY01).replace(/^0+/, "") ===
          km[1]!.replace(/^0+/, ""),
      );
      if (row) {
        const ref = `CanonicalTableRow:${row.source_key}`;
        changes.push(`row→${ref}`);
        return ref;
      }
    }
    return ev;
  };

  const facts = params.record.facts.map((f) => {
    const evidence = (f.evidence ?? []).map(mapEvidence);
    if (evidence.length === 0) facts_without_evidence.push(f.text);
    return { ...f, evidence };
  });

  // Detect over-generalization phrasing in inferences
  for (const inf of params.record.inferences) {
    if (
      /\balle\b|\bimmer\b|\bgenerell\b|\bjeder Mandant\b|\bandere Systeme\b/i.test(
        inf.text,
      )
    ) {
      generalizations.push(inf.text);
    }
  }

  const topEvidence = Array.from(
    new Set([
      defRef,
      ...(classRef ? [classRef] : []),
      ...params.rows.slice(0, 3).map((r) => `CanonicalTableRow:${r.source_key}`),
    ]),
  );

  return {
    record: {
      ...params.record,
      facts,
      evidence: topEvidence,
    },
    facts_without_evidence,
    generalizations,
    changes,
  };
}

export function validateHardenedInterpretation(params: {
  record: CodeTableInterpretationRecord & {
    access_id?: string;
    business_rule_id?: string;
  };
  sourceCode: string;
  tableRow: {
    source_key: string;
    primary_key: Record<string, string>;
    values: Record<string, string>;
  };
  expectedResolvedKey: string;
}): AnalysisDeviation[] {
  const out: AnalysisDeviation[] = [];
  const at = new Date().toISOString();
  const r = params.record;

  if (r.resolved_key !== params.expectedResolvedKey) {
    out.push({
      at,
      scope: "code_table_interpretation",
      source_key: r.source_key,
      code: "RESOLVED_KEY_MISMATCH",
      message: "resolved_key stimmt nicht",
    });
  }
  for (const [k, v] of Object.entries(r.resolved_values)) {
    const expected = params.tableRow.values[k] ?? params.tableRow.primary_key[k];
    if (expected != null && String(expected) !== String(v)) {
      out.push({
        at,
        scope: "code_table_interpretation",
        source_key: r.source_key,
        code: "RESOLVED_VALUE_MISMATCH",
        message: `resolved_values.${k}`,
        details: { expected, actual: v },
      });
    }
  }
  for (const ev of r.evidence_from_code) {
    if (!isExactCodeEvidence(params.sourceCode, ev)) {
      out.push({
        at,
        scope: "code_table_interpretation",
        source_key: r.source_key,
        code: "CODE_EVIDENCE_NOT_EXACT",
        message: ev.slice(0, 160),
      });
    }
  }
  if (/\.\.\./.test(r.evidence_from_code.join("\n"))) {
    out.push({
      at,
      scope: "code_table_interpretation",
      source_key: r.source_key,
      code: "CODE_EVIDENCE_ELLIPSIS",
      message: "Auslassungszeichen in Code-Evidence",
    });
  }
  if (
    /anderer Mandant|andere Systeme|alle Mandanten|Produktionssystem allgemein/i.test(
      `${r.technical_interpretation}\n${r.business_rule_inferred}`,
    )
  ) {
    out.push({
      at,
      scope: "code_table_interpretation",
      source_key: r.source_key,
      code: "CROSS_SYSTEM_CLAIM",
      message: "Aussage über andere Systeme/Mandanten",
    });
  }
  if (!r.access_id || !r.business_rule_id) {
    out.push({
      at,
      scope: "code_table_interpretation",
      source_key: r.source_key,
      code: "MISSING_GROUPING_IDS",
      message: "access_id/business_rule_id fehlen",
    });
  }
  return out;
}
