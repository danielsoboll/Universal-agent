/**
 * Harden pilot quality for existing 10 table analyses + 5 code-table interpretations.
 * No new tables, no architecture/CLI/registry changes, same OpenAI model.
 *
 *   npm run harden:pilot-control-tables-quality
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  buildCodeTableInterpretationSystemPrompt,
  buildCodeTableInterpretationUserPrompt,
} from "../src/lib/analysis/controlTablePilotPrompts";
import {
  buildNumberedSnippet,
  countExactCodeEvidence,
  countExactTableEvidence,
  deterministicCodeEvidence,
  deterministicTableEvidence,
  effectFingerprintFromWindow,
  extractAccessEvidenceWindow,
  hardenTableAnalysisEvidence,
  makeAccessId,
  makeBusinessRuleId,
  validateHardenedInterpretation,
} from "../src/lib/analysis/controlTablePilotHarden";
import {
  CODE_TABLE_INTERPRETATION_PROMPT_VERSION,
  analysisDeviationSchema,
  codeTableInterpretationModelSchema,
  codeTableInterpretationRecordSchema,
  controlTableAnalysisRecordSchema,
  type AnalysisDeviation,
  type CodeTableInterpretationRecord,
  type ControlTableAnalysisRecord,
} from "../src/lib/analysis/controlTablePilotSchema";
import {
  generateStructuredWithUsage,
  sha256Stable,
} from "../src/lib/analysis/pilotOpenAi";
import { AI_CONFIG } from "../src/lib/ai/config";
import { LocalDataError } from "../src/lib/localData/errors";
import { writeGeneratedText } from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";

const PROJECT_KEY = "P01";

type Row = {
  source_key: string;
  table_name: string;
  primary_key: Record<string, string>;
  values: Record<string, string>;
  row_hash: string;
  content_hash: string;
};

type Access = {
  code_source_key: string;
  method_name: string;
  table_name: string;
  evidence_code: string;
  where: unknown;
};

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q)) return v.slice(1, -1);
  }
  return v;
}

function loadEnvFile(filename: string) {
  try {
    const text = readFileSync(path.resolve(process.cwd(), filename), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ")
        ? line.slice("export ".length).trim()
        : line;
      const eq = normalized.indexOf("=");
      if (eq <= 0) continue;
      const key = normalized.slice(0, eq).trim();
      const value = stripQuotes(normalized.slice(eq + 1));
      if (!key) continue;
      if (!process.env[key] || process.env[key]?.trim() === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // later
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJsonl<T>(absolute: string): T[] {
  if (!existsSync(absolute)) return [];
  return readFileSync(absolute, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function serializePk(primaryKey: Record<string, string>): string {
  return Object.entries(primaryKey)
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

function literalFromWhere(where: unknown): string | null {
  if (!Array.isArray(where)) return null;
  for (const w of where as Array<{ resolved_literal?: string; raw_value?: string }>) {
    if (w.resolved_literal != null) return String(w.resolved_literal);
    if (w.raw_value != null && /^'?0*\d+'?$/.test(String(w.raw_value))) {
      return String(w.raw_value).replace(/'/g, "");
    }
  }
  return null;
}

function matchRowByKey01(rows: Row[], lit: string): Row | undefined {
  const nb = String(lit).replace(/^0+/, "") || "0";
  return rows.find((r) => {
    if (r.table_name !== "ZEXTO_PARAMETER") return false;
    const keyVal = r.primary_key.KEY01 ?? r.values.KEY01;
    const na = String(keyVal).replace(/^0+/, "") || "0";
    return na === nb || String(keyVal) === String(lit);
  });
}

function needsOpenAiRerun(_params: {
  prior: CodeTableInterpretationRecord;
  sourceCode: string;
  snippetWasIncomplete: boolean;
  window: Array<{ line: number; text: string }>;
}): boolean {
  // Quality harden: always re-interpret with expanded exact window.
  return true;
}

async function main() {
  loadEnvFile(".env.local");
  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }
  if (!process.env.OPENAI_API_KEY?.trim()) fail("OPENAI_API_KEY fehlt");

  const tablesPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    "control-tables/table_analyses.jsonl",
  );
  const interpsPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    "relations/code_table_interpretations.jsonl",
  );
  const defsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_definitions.jsonl",
  );
  const classPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_classifications.jsonl",
  );
  const rowsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_rows.jsonl",
  );
  const unitsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "classes/code_units.jsonl",
  );
  const accessesPath = resolveWritablePath(
    PROJECT_KEY,
    "logs",
    "code_table_accesses.jsonl",
  );
  const unitAnalysesPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    "classes/unit_analyses.jsonl",
  );

  const tables = readJsonl<ControlTableAnalysisRecord>(tablesPath).map((t) =>
    controlTableAnalysisRecordSchema.parse(t),
  );
  const priorInterps = readJsonl<CodeTableInterpretationRecord>(interpsPath);
  const defs = new Map(
    readJsonl<Record<string, unknown>>(defsPath).map((d) => [
      String(d.table_name),
      d,
    ]),
  );
  const classif = new Map(
    readJsonl<Record<string, unknown>>(classPath).map((c) => [
      String(c.table_name),
      c,
    ]),
  );
  const allRows = readJsonl<Row>(rowsPath);
  const rowsByTable = new Map<string, Row[]>();
  for (const r of allRows) {
    const list = rowsByTable.get(r.table_name) ?? [];
    list.push(r);
    rowsByTable.set(r.table_name, list);
  }
  const rowsByKey = new Map(allRows.map((r) => [r.source_key, r]));
  const unitsByKey = new Map(
    readJsonl<Record<string, unknown>>(unitsPath).map((u) => [
      String(u.source_key),
      u,
    ]),
  );
  const unitAnalyses = new Map(
    readJsonl<Record<string, unknown>>(unitAnalysesPath).map((u) => [
      String(u.source_key),
      u,
    ]),
  );

  const resolvedAccesses = readJsonl<Access>(accessesPath).filter(
    (a) =>
      a.table_name === "ZEXTO_PARAMETER" && literalFromWhere(a.where) != null,
  );

  // Pair prior interps with access occurrences (stable order = prior file order)
  type Target = {
    prior: CodeTableInterpretationRecord;
    access: Access;
    occurrence_index: number;
    row: Row;
    source_code: string;
    window: ReturnType<typeof extractAccessEvidenceWindow>;
    snippet_incomplete_before: boolean;
  };

  const occCounter = new Map<string, number>();
  const targets: Target[] = [];

  for (const prior of priorInterps) {
    const candidates = resolvedAccesses.filter(
      (a) =>
        a.code_source_key === prior.code_source_key &&
        a.table_name === prior.table_name,
    );
    // Prefer access whose literal matches resolved KEY01
    const keyPart = prior.resolved_key.split("|").find((p) => p.startsWith("KEY01="));
    const keyLit = keyPart?.slice("KEY01=".length) ?? "";
    const matched =
      candidates.find((a) => {
        const lit = literalFromWhere(a.where);
        if (lit == null) return false;
        const na = String(lit).replace(/^0+/, "") || "0";
        const nb = keyLit.replace(/^0+/, "") || "0";
        return na === nb;
      }) ?? candidates[0];

    if (!matched) {
      fail(`Kein Access für Interpretation ${prior.source_key}`);
    }

    const occKey = `${matched.code_source_key}||${matched.evidence_code}`;
    const occurrence_index = occCounter.get(occKey) ?? 0;
    occCounter.set(occKey, occurrence_index + 1);

    const unit = unitsByKey.get(prior.code_source_key);
    if (!unit) fail(`Code unit fehlt: ${prior.code_source_key}`);
    const source_code = String(unit.source_code ?? "");
    const row = rowsByKey.get(prior.table_row_source_key);
    if (!row) fail(`Row fehlt: ${prior.table_row_source_key}`);

    const window = extractAccessEvidenceWindow({
      sourceCode: source_code,
      evidenceCode: matched.evidence_code,
      occurrenceIndex: occurrence_index,
      afterRadius: 16,
    });

    const oldSnippetLikelyIncomplete =
      /DOWNLOAD_OPTO_OUTPUT/.test(prior.method_name) &&
      !prior.evidence_from_code.some((e) => /SELECT/i.test(e));

    targets.push({
      prior,
      access: matched,
      occurrence_index,
      row,
      source_code,
      window,
      snippet_incomplete_before: oldSnippetLikelyIncomplete,
    });
  }

  if (targets.length !== 5) {
    fail(`Erwarte 5 Targets, gefunden: ${targets.length}`);
  }

  // --- Before stats ---
  const beforeCode = targets.map((t) =>
    countExactCodeEvidence(t.source_code, t.prior.evidence_from_code),
  );
  const beforeTable = targets.map((t) =>
    countExactTableEvidence(t.row, t.prior.evidence_from_table),
  );

  let sumIn = 0;
  let sumOut = 0;
  let sumCost = 0;
  let sumDur = 0;
  const reanalyzed: string[] = [];
  const deviations: AnalysisDeviation[] = [];
  const nextInterps: Array<
    CodeTableInterpretationRecord & {
      access_id: string;
      business_rule_id: string;
    }
  > = [];

  for (const t of targets) {
    const detCode = deterministicCodeEvidence(t.window);
    const detTable = deterministicTableEvidence(t.row);
    const lineStart = t.window[0]?.line ?? 0;
    const access_id = makeAccessId({
      code_source_key: t.prior.code_source_key,
      table_name: t.prior.table_name,
      evidence_code: t.access.evidence_code,
      occurrence_index: t.occurrence_index,
      line_start: lineStart,
    });
    const business_rule_id = makeBusinessRuleId({
      code_source_key: t.prior.code_source_key,
      table_name: t.prior.table_name,
      resolved_key: t.prior.resolved_key,
      effect_fingerprint: effectFingerprintFromWindow(t.window),
    });

    const snippet = buildNumberedSnippet(t.window);
    const rerun = needsOpenAiRerun({
      prior: t.prior,
      sourceCode: t.source_code,
      snippetWasIncomplete: t.snippet_incomplete_before,
      window: t.window,
    });

    let modelPart = {
      matched_conditions: t.prior.matched_conditions,
      code_usage_after_read: t.prior.code_usage_after_read,
      technical_interpretation: t.prior.technical_interpretation,
      business_rule_inferred: t.prior.business_rule_inferred,
      facts: t.prior.facts,
      inferences: t.prior.inferences,
      confidence: t.prior.confidence,
      unresolved_points: t.prior.unresolved_points,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost: 0,
      duration_ms: 0,
      model: t.prior.model,
    };

    if (rerun) {
      const def = defs.get(t.prior.table_name);
      const unitAnalysis = unitAnalyses.get(t.prior.code_source_key);
      const tableAnalysis = tables.find(
        (x) => x.table_name === t.prior.table_name,
      );
      console.log(
        `Re-run OpenAI: ${t.prior.method_name} occ=${t.occurrence_index} window L${t.window[0]?.line}-L${t.window.at(-1)?.line}`,
      );
      const call = await generateStructuredWithUsage({
        schema: codeTableInterpretationModelSchema,
        schemaName: "code_table_interpretation_v1",
        system: buildCodeTableInterpretationSystemPrompt(),
        user: buildCodeTableInterpretationUserPrompt({
          className: t.prior.class_name,
          methodName: t.prior.method_name,
          tableName: t.prior.table_name,
          codeSnippet: snippet,
          whereConditionsJson: JSON.stringify(t.access.where, null, 2),
          tableRowJson: JSON.stringify(
            {
              source_key: t.row.source_key,
              primary_key: t.row.primary_key,
              values: t.row.values,
            },
            null,
            2,
          ),
          fieldDefsJson: JSON.stringify(
            ((def?.fields as Array<Record<string, unknown>>) ?? []).filter(
              (f) => {
                const name = String(f.field_name ?? "");
                return (
                  (def?.key_fields as string[] | undefined)?.includes(name) ||
                  Object.keys(t.row.values).includes(name)
                );
              },
            ),
            null,
            2,
          ),
          unitAnalysisSummaryJson: JSON.stringify(
            unitAnalysis
              ? {
                  technical_summary: unitAnalysis.technical_summary,
                  business_purpose_inferred:
                    unitAnalysis.business_purpose_inferred,
                  confidence: unitAnalysis.confidence,
                }
              : null,
            null,
            2,
          ),
          tableAnalysisSummaryJson: JSON.stringify(
            tableAnalysis
              ? {
                  technical_purpose: tableAnalysis.technical_purpose,
                  likely_table_role: tableAnalysis.likely_table_role,
                  confidence: tableAnalysis.confidence,
                }
              : null,
            null,
            2,
          ),
        }),
        model: AI_CONFIG.chatModel,
      });

      modelPart = {
        matched_conditions: call.data.matched_conditions,
        code_usage_after_read: call.data.code_usage_after_read,
        technical_interpretation: call.data.technical_interpretation,
        business_rule_inferred: call.data.business_rule_inferred,
        facts: call.data.facts,
        inferences: [
          ...call.data.inferences,
          // Ensure business rule is explicitly marked as inference carrier
        ],
        confidence: call.data.confidence,
        unresolved_points: call.data.unresolved_points,
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        estimated_cost: call.estimated_cost,
        duration_ms: call.duration_ms,
        model: call.model,
      };
      sumIn += call.input_tokens;
      sumOut += call.output_tokens;
      sumCost += call.estimated_cost;
      sumDur += call.duration_ms;
      reanalyzed.push(t.prior.source_key);
    }

    // Always overwrite evidence with deterministic exact lines — never store paraphrases
    const evidence_from_code = detCode;
    const evidence_from_table = detTable;

    // Ensure business_rule_inferred is reflected in inferences if missing
    const inferences = [...modelPart.inferences];
    if (
      modelPart.business_rule_inferred &&
      !inferences.some((i) => i.text === modelPart.business_rule_inferred)
    ) {
      inferences.push({
        text: modelPart.business_rule_inferred,
        evidence: evidence_from_code.slice(0, 4),
      });
    }

    // Facts: keep model facts but force evidence refs that exist
    const facts = modelPart.facts.map((f) => ({
      text: f.text,
      evidence: (f.evidence ?? [])
        .map((e) => {
          if (evidence_from_code.some((c) => c.includes(e) || e.includes(c))) {
            return (
              evidence_from_code.find((c) => c.includes(e) || e.includes(c)) ??
              e
            );
          }
          if (/VAL01|KEY01|TEXT1|MANDT/.test(e)) {
            const hit = evidence_from_table.find((tEv) =>
              e.includes(tEv.split("=")[0] ?? "___"),
            );
            return hit ?? e;
          }
          return e;
        })
        .filter((e) => {
          const okCode = evidence_from_code.includes(e);
          const okTable =
            evidence_from_table.includes(e) ||
            e.startsWith("CanonicalTableRow:");
          // Drop unverified paraphrases
          return okCode || okTable || isExactishFactEvidence(e, t);
        }),
    }));

    // Prefer model usage lines that appear in the window; else deterministic IF/UPDATE/ME lines
    const usageFromModel = modelPart.code_usage_after_read.filter((u) =>
      t.window.some(
        (l) =>
          l.text.includes(u.replace(/^L\d+\|/, "").slice(0, 24)) ||
          u.includes(l.text.trim().slice(0, 24)),
      ),
    );
    const usageFallback = t.window
      .filter((l) => /IF |ELSE|UPDATE|EQ |CS |ME->|L_STAT/i.test(l.text))
      .map((l) => formatLine(l));
    const code_usage_after_read =
      usageFromModel.length > 0 ? usageFromModel : usageFallback;

    const content_hash = sha256Stable({
      access_id,
      business_rule_id,
      window: t.window.map((l) => formatLine(l)),
      row_hash: t.row.row_hash,
      prompt: CODE_TABLE_INTERPRETATION_PROMPT_VERSION,
      harden: "v1",
    });

    const record = codeTableInterpretationRecordSchema.parse({
      matched_conditions: Array.isArray(t.access.where)
        ? (t.access.where as unknown[]).map((w) => JSON.stringify(w))
        : modelPart.matched_conditions,
      code_usage_after_read,
      technical_interpretation: modelPart.technical_interpretation,
      business_rule_inferred: modelPart.business_rule_inferred,
      facts,
      inferences,
      evidence_from_code,
      evidence_from_table,
      confidence: modelPart.confidence,
      unresolved_points: modelPart.unresolved_points,
      source_key: t.prior.source_key,
      code_source_key: t.prior.code_source_key,
      class_name: t.prior.class_name,
      method_name: t.prior.method_name,
      table_name: t.prior.table_name,
      table_row_source_key: t.prior.table_row_source_key,
      resolved_key: serializePk(t.row.primary_key),
      resolved_values: { ...t.row.values },
      access_id,
      business_rule_id,
      model: modelPart.model,
      prompt_version: CODE_TABLE_INTERPRETATION_PROMPT_VERSION,
      content_hash,
      input_tokens: modelPart.input_tokens || t.prior.input_tokens,
      output_tokens: modelPart.output_tokens || t.prior.output_tokens,
      estimated_cost: modelPart.estimated_cost || t.prior.estimated_cost,
      duration_ms: modelPart.duration_ms || t.prior.duration_ms,
    });

    deviations.push(
      ...validateHardenedInterpretation({
        record,
        sourceCode: t.source_code,
        tableRow: t.row,
        expectedResolvedKey: serializePk(t.row.primary_key),
      }),
    );

    // Final safety: if any code evidence not exact, abort write for this record
    const check = countExactCodeEvidence(t.source_code, record.evidence_from_code);
    if (check.bad.length > 0) {
      fail(
        `Ungültige Code-Evidence nach Härtung (${t.prior.method_name}): ${check.bad[0]}`,
      );
    }

    nextInterps.push(record);
    console.log(
      `OK ${record.method_name} access=${access_id} brule=${business_rule_id} code_ev=${record.evidence_from_code.length} exact`,
    );
  }

  // --- Table analyses harden (deterministic, no new OpenAI) ---
  const tableIssues = {
    facts_without_evidence: [] as Array<{ table: string; text: string }>,
    generalizations: [] as Array<{ table: string; text: string }>,
  };
  const nextTables: ControlTableAnalysisRecord[] = [];
  for (const table of tables) {
    const def = defs.get(table.table_name);
    if (!def) {
      nextTables.push(table);
      continue;
    }
    const hardened = hardenTableAnalysisEvidence({
      record: table,
      definition: {
        source_key: String(def.source_key),
        description: String(def.description ?? ""),
        table_name: table.table_name,
      },
      rows: rowsByTable.get(table.table_name) ?? [],
      classification: classif.get(table.table_name) as
        | { classification?: string }
        | undefined,
    });
    for (const f of hardened.facts_without_evidence) {
      tableIssues.facts_without_evidence.push({
        table: table.table_name,
        text: f,
      });
      deviations.push({
        at: new Date().toISOString(),
        scope: "table_analysis",
        source_key: table.source_key,
        code: "FACT_WITHOUT_EVIDENCE",
        message: f.slice(0, 200),
      });
    }
    for (const g of hardened.generalizations) {
      tableIssues.generalizations.push({
        table: table.table_name,
        text: g,
      });
      deviations.push({
        at: new Date().toISOString(),
        scope: "table_analysis",
        source_key: table.source_key,
        code: "UNALLOWED_GENERALIZATION",
        message: g.slice(0, 200),
      });
    }
    nextTables.push(hardened.record);
  }

  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "control-tables/table_analyses.jsonl",
    `${nextTables.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "relations/code_table_interpretations.jsonl",
    `${nextInterps.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );

  const parsedDevs = deviations
    .map((d) => analysisDeviationSchema.safeParse(d))
    .filter((p) => p.success)
    .map((p) => p.data);
  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "control-tables/analysis_deviations.jsonl",
    parsedDevs.length
      ? `${parsedDevs.map((d) => JSON.stringify(d)).join("\n")}\n`
      : "",
  );

  const afterCode = nextInterps.map((r, i) =>
    countExactCodeEvidence(targets[i]!.source_code, r.evidence_from_code),
  );
  const afterTable = nextInterps.map((r, i) =>
    countExactTableEvidence(targets[i]!.row, r.evidence_from_table),
  );

  const bruleGroups = new Map<string, string[]>();
  for (const r of nextInterps) {
    const list = bruleGroups.get(r.business_rule_id) ?? [];
    list.push(`${r.method_name}#${r.access_id}`);
    bruleGroups.set(r.business_rule_id, list);
  }

  const unresolved = {
    tables: nextTables.flatMap((t) =>
      t.unresolved_points.map((u) => ({ table: t.table_name, unresolved: u })),
    ),
    interpretations: nextInterps.flatMap((r) =>
      r.unresolved_points.map((u) => ({
        method: r.method_name,
        access_id: r.access_id,
        unresolved: u,
      })),
    ),
  };

  const compact = nextInterps.map((r) => ({
    methode: r.method_name,
    tabelle: r.table_name,
    schluessel: r.resolved_key,
    tabellenwert: r.resolved_values,
    technische_verwendung: r.technical_interpretation,
    geschaeftsregel: r.business_rule_inferred,
    confidence: r.confidence,
    evidence_status: {
      code_exact: `${countExactCodeEvidence(targets.find((t) => t.prior.source_key === r.source_key)!.source_code, r.evidence_from_code).exact}/${r.evidence_from_code.length}`,
      table_exact: `${countExactTableEvidence(targets.find((t) => t.prior.source_key === r.source_key)!.row, r.evidence_from_table).exact}/${r.evidence_from_table.length}`,
    },
    access_id: r.access_id,
    business_rule_id: r.business_rule_id,
  }));

  const report = {
    at: new Date().toISOString(),
    model: AI_CONFIG.chatModel,
    tabellenanalysen_geprueft: nextTables.length,
    interpretationen_geprueft: nextInterps.length,
    exakte_code_evidence_vorher: {
      exact: beforeCode.reduce((s, x) => s + x.exact, 0),
      total: beforeCode.reduce((s, x) => s + x.total, 0),
      per_record: beforeCode.map((x, i) => ({
        method: targets[i]!.prior.method_name,
        exact: x.exact,
        total: x.total,
        bad: x.bad,
      })),
    },
    exakte_code_evidence_nachher: {
      exact: afterCode.reduce((s, x) => s + x.exact, 0),
      total: afterCode.reduce((s, x) => s + x.total, 0),
      per_record: afterCode.map((x, i) => ({
        method: nextInterps[i]!.method_name,
        exact: x.exact,
        total: x.total,
        bad: x.bad,
      })),
    },
    exakte_tabellen_evidence_vorher: {
      exact: beforeTable.reduce((s, x) => s + x.exact, 0),
      total: beforeTable.reduce((s, x) => s + x.total, 0),
    },
    exakte_tabellen_evidence_nachher: {
      exact: afterTable.reduce((s, x) => s + x.exact, 0),
      total: afterTable.reduce((s, x) => s + x.total, 0),
    },
    neu_analysierte_betroffene_records: reanalyzed,
    technische_zugriffe: nextInterps.map((r) => ({
      access_id: r.access_id,
      method: r.method_name,
      table: r.table_name,
      resolved_key: r.resolved_key,
    })),
    gruppierbare_geschaeftsregeln: [...bruleGroups.entries()].map(
      ([id, members]) => ({
        business_rule_id: id,
        member_count: members.length,
        members,
      }),
    ),
    facts_ohne_beleg: tableIssues.facts_without_evidence,
    unzulaessige_generalisierungen: tableIssues.generalizations,
    unresolved_punkte: unresolved,
    verbleibende_abweichungen: parsedDevs,
    tokenverbrauch_und_kosten_reparatur: {
      input_tokens: sumIn,
      output_tokens: sumOut,
      estimated_cost_usd: Number(sumCost.toFixed(6)),
      duration_ms: sumDur,
      re_runs: reanalyzed.length,
    },
    kompakte_interpretationen: compact,
  };

  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "control-tables/pilot-quality-report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log("\n=== QUALITÄTSBERICHT ===");
  console.log(`Tabellen geprüft: ${report.tabellenanalysen_geprueft}`);
  console.log(`Interpretationen geprüft: ${report.interpretationen_geprueft}`);
  console.log(
    `Code-Evidence exakt vorher/nachher: ${report.exakte_code_evidence_vorher.exact}/${report.exakte_code_evidence_vorher.total} → ${report.exakte_code_evidence_nachher.exact}/${report.exakte_code_evidence_nachher.total}`,
  );
  console.log(
    `Tabellen-Evidence exakt vorher/nachher: ${report.exakte_tabellen_evidence_vorher.exact}/${report.exakte_tabellen_evidence_vorher.total} → ${report.exakte_tabellen_evidence_nachher.exact}/${report.exakte_tabellen_evidence_nachher.total}`,
  );
  console.log(`Re-runs: ${reanalyzed.length}`);
  console.log(
    `Tokens in/out: ${sumIn}/${sumOut} Kosten: ${report.tokenverbrauch_und_kosten_reparatur.estimated_cost_usd}`,
  );
  console.log(`Abweichungen: ${parsedDevs.length}`);
  console.log(
    `Geschäftsregel-Gruppen: ${report.gruppierbare_geschaeftsregeln.length}`,
  );
  for (const c of compact) {
    console.log(
      `- ${c.methode} | ${c.schluessel} | conf=${c.confidence} | ${c.evidence_status.code_exact} code | brule=${c.business_rule_id}`,
    );
  }
}

function formatLine(l: { line: number; text: string }): string {
  return `L${l.line}|${l.text}`;
}

function isExactishFactEvidence(
  e: string,
  t: { row: Row; window: Array<{ line: number; text: string }> },
): boolean {
  if (e.startsWith("CanonicalTableRow:")) return true;
  if (t.window.some((l) => l.text.includes(e) || formatLine(l) === e)) {
    return true;
  }
  const blob = JSON.stringify(t.row);
  return blob.includes(e);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
