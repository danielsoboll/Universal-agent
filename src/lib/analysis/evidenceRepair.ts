export type EvidenceLine = {
  line: number;
  quote: string;
};

export type EvidenceMismatch = {
  code: "EVIDENCE_MISMATCH";
  scope: "fact" | "inference" | "top";
  statement?: string;
  line: number | null;
  quote: string;
  reason: string;
};

export type EvidenceRepairStats = {
  valid: number;
  corrigible: number;
  mismatches: number;
};

export type EvidenceRepairResult = {
  evidence_lines: EvidenceLine[];
  stats: EvidenceRepairStats;
  mismatches: EvidenceMismatch[];
};

function sourceLinesOf(sourceCode: string): string[] {
  return sourceCode.replace(/\r\n/g, "\n").split("\n");
}

function stripEllipsis(quote: string): string {
  return quote.replace(/\s*\.\.\.\s*$/g, "").trim();
}

/**
 * Repair one evidence list against original source_code.
 * - exact line+quote → valid
 * - valid line with wrong/ellipsis quote → quote replaced from source (corrigible)
 * - quote uniquely finds another line → line corrected (corrigible)
 * - otherwise → EVIDENCE_MISMATCH, not stored
 */
export function repairEvidenceLines(
  entries: EvidenceLine[] | undefined,
  sourceCode: string,
  scope: EvidenceMismatch["scope"],
  statement?: string,
): EvidenceRepairResult {
  const sourceLines = sourceLinesOf(sourceCode);
  const out: EvidenceLine[] = [];
  const mismatches: EvidenceMismatch[] = [];
  let valid = 0;
  let corrigible = 0;
  let mismatchCount = 0;

  for (const entry of entries ?? []) {
    const line = Number(entry.line);
    const quote = typeof entry.quote === "string" ? entry.quote : "";
    const cleaned = stripEllipsis(quote);

    if (!quote.trim()) {
      mismatchCount += 1;
      mismatches.push({
        code: "EVIDENCE_MISMATCH",
        scope,
        statement,
        line: Number.isFinite(line) ? line : null,
        quote,
        reason: "Leeres Evidence-Quote",
      });
      continue;
    }

    const lineInRange =
      Number.isInteger(line) && line >= 1 && line <= sourceLines.length;
    const exactAtLine = lineInRange ? (sourceLines[line - 1] ?? "") : "";

    if (lineInRange && quote === exactAtLine) {
      valid += 1;
      out.push({ line, quote: exactAtLine });
      continue;
    }

    if (lineInRange && exactAtLine.trim() === cleaned) {
      corrigible += 1;
      out.push({ line, quote: exactAtLine });
      continue;
    }

    if (
      lineInRange &&
      cleaned.length >= 8 &&
      (exactAtLine.includes(cleaned) || cleaned.includes(exactAtLine.trim()))
    ) {
      // Partial/ellipsis quote for the declared line → take full original line
      corrigible += 1;
      out.push({ line, quote: exactAtLine });
      continue;
    }

    // Try unique exact/trim match elsewhere in the unit
    const matchIndexes: number[] = [];
    for (let i = 0; i < sourceLines.length; i++) {
      const src = sourceLines[i] ?? "";
      if (src === quote || src.trim() === cleaned) matchIndexes.push(i);
    }
    if (matchIndexes.length === 1) {
      const idx = matchIndexes[0]!;
      corrigible += 1;
      out.push({ line: idx + 1, quote: sourceLines[idx]! });
      continue;
    }

    mismatchCount += 1;
    mismatches.push({
      code: "EVIDENCE_MISMATCH",
      scope,
      statement,
      line: Number.isFinite(line) ? line : null,
      quote,
      reason: lineInRange
        ? "Quote passt nicht zur angegebenen source_code-Zeile und konnte nicht eindeutig zugeordnet werden"
        : `Zeilennummer außerhalb von source_code (1..${sourceLines.length})`,
    });
  }

  return {
    evidence_lines: out,
    stats: { valid, corrigible, mismatches: mismatchCount },
    mismatches,
  };
}

export type EvidencedStatement = {
  text: string;
  evidence_lines: EvidenceLine[];
};

export function repairEvidencedStatements(
  statements: EvidencedStatement[] | undefined,
  sourceCode: string,
  scope: "fact" | "inference",
): {
  statements: EvidencedStatement[];
  stats: EvidenceRepairStats;
  mismatches: EvidenceMismatch[];
  statementsWithoutEvidence: number;
} {
  const out: EvidencedStatement[] = [];
  const mismatches: EvidenceMismatch[] = [];
  const stats: EvidenceRepairStats = { valid: 0, corrigible: 0, mismatches: 0 };
  let statementsWithoutEvidence = 0;

  for (const stmt of statements ?? []) {
    const repaired = repairEvidenceLines(
      stmt.evidence_lines,
      sourceCode,
      scope,
      stmt.text,
    );
    stats.valid += repaired.stats.valid;
    stats.corrigible += repaired.stats.corrigible;
    stats.mismatches += repaired.stats.mismatches;
    mismatches.push(...repaired.mismatches);

    if (repaired.evidence_lines.length === 0) {
      statementsWithoutEvidence += 1;
      mismatches.push({
        code: "EVIDENCE_MISMATCH",
        scope,
        statement: stmt.text,
        line: null,
        quote: "",
        reason: "Aussage ohne gültige Evidence nach Validierung",
      });
      continue;
    }

    out.push({
      text: stmt.text,
      evidence_lines: repaired.evidence_lines,
    });
  }

  return { statements: out, stats, mismatches, statementsWithoutEvidence };
}
