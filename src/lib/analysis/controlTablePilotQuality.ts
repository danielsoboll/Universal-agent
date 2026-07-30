import type { AnalysisDeviation } from "@/lib/analysis/controlTablePilotSchema";
import type {
  CodeTableInterpretationRecord,
  ControlTableAnalysisRecord,
} from "@/lib/analysis/controlTablePilotSchema";

function sourceHasLine(sourceCode: string, quote: string): boolean {
  const q = quote.trim();
  if (!q) return false;
  const normalized = sourceCode.replace(/\r\n/g, "\n");
  if (normalized.includes(q)) return true;
  // allow whitespace-collapsed match for short snippets
  const compactSrc = normalized.replace(/\s+/g, " ");
  const compactQ = q.replace(/\s+/g, " ");
  return compactQ.length >= 8 && compactSrc.includes(compactQ);
}

export function validateTableAnalysis(params: {
  record: ControlTableAnalysisRecord;
  definition: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
}): AnalysisDeviation[] {
  const out: AnalysisDeviation[] = [];
  const at = new Date().toISOString();
  const table = params.record.table_name;
  const defText = JSON.stringify(params.definition);
  const rowsText = JSON.stringify(params.rows);

  for (const fact of params.record.facts) {
    for (const ev of fact.evidence) {
      if (!defText.includes(ev) && !rowsText.includes(ev) && ev.length > 3) {
        // soft: evidence may be paraphrased field names — only flag if looks like invented table value
        if (/^[A-Z0-9_]{2,}=\S+/.test(ev) && !rowsText.includes(ev.split("=")[1] ?? "___")) {
          out.push({
            at,
            scope: "table_analysis",
            source_key: params.record.source_key,
            code: "FACT_EVIDENCE_UNVERIFIED",
            message: `Fact-Evidence nicht in Definition/Zeilen gefunden: ${ev.slice(0, 120)}`,
          });
        }
      }
    }
  }

  for (const sys of params.record.system_references) {
    if (/^(L_|G_|LT_|GT_|SY-|ME->)/i.test(sys.trim())) {
      out.push({
        at,
        scope: "table_analysis",
        source_key: params.record.source_key,
        code: "INTERNAL_AS_EXTERNAL_SYSTEM",
        message: `Interne Variable als Systemreferenz: ${sys}`,
      });
    }
  }

  void table;
  return out;
}

export function validateCodeTableInterpretation(params: {
  record: CodeTableInterpretationRecord;
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

  if (r.table_row_source_key !== params.tableRow.source_key) {
    out.push({
      at,
      scope: "code_table_interpretation",
      source_key: r.source_key,
      code: "ROW_KEY_MISMATCH",
      message: `table_row_source_key weicht ab`,
      details: {
        expected: params.tableRow.source_key,
        actual: r.table_row_source_key,
      },
    });
  }

  if (r.resolved_key !== params.expectedResolvedKey) {
    out.push({
      at,
      scope: "code_table_interpretation",
      source_key: r.source_key,
      code: "RESOLVED_KEY_MISMATCH",
      message: `resolved_key stimmt nicht mit Canonical überein`,
      details: {
        expected: params.expectedResolvedKey,
        actual: r.resolved_key,
      },
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
        message: `resolved_values.${k} weicht ab`,
        details: { expected, actual: v },
      });
    }
  }

  for (const ev of r.evidence_from_code) {
    if (!sourceHasLine(params.sourceCode, ev)) {
      out.push({
        at,
        scope: "code_table_interpretation",
        source_key: r.source_key,
        code: "CODE_EVIDENCE_MISSING",
        message: `Code-Evidence nicht exakt im Quelltext: ${ev.slice(0, 160)}`,
      });
    }
  }

  const rowBlob = JSON.stringify(params.tableRow);
  for (const ev of r.evidence_from_table) {
    const compact = ev.trim();
    if (
      compact &&
      !rowBlob.includes(compact) &&
      !Object.values(params.tableRow.values).some((v) => compact.includes(v)) &&
      !Object.values(params.tableRow.primary_key).some((v) =>
        compact.includes(v),
      )
    ) {
      out.push({
        at,
        scope: "code_table_interpretation",
        source_key: r.source_key,
        code: "TABLE_EVIDENCE_MISSING",
        message: `Tabellen-Evidence nicht in Canonical-Zeile: ${compact.slice(0, 160)}`,
      });
    }
  }

  return out;
}
