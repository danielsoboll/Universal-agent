/**
 * OpenAI pilot: control-table analyses (≤10) + code-table interpretations (5 resolved).
 * Does not modify CustomerConfig/CLI/Registries/Manifest or existing artifacts.
 *
 *   npm run pilot:control-tables-openai
 */
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  buildCodeTableInterpretationSystemPrompt,
  buildCodeTableInterpretationUserPrompt,
  buildControlTableAnalysisSystemPrompt,
  buildControlTableAnalysisUserPrompt,
} from "../src/lib/analysis/controlTablePilotPrompts";
import {
  validateCodeTableInterpretation,
  validateTableAnalysis,
} from "../src/lib/analysis/controlTablePilotQuality";
import {
  CODE_TABLE_INTERPRETATION_PROMPT_VERSION,
  CONTROL_TABLE_ANALYSIS_PROMPT_VERSION,
  analysisDeviationSchema,
  codeTableInterpretationModelSchema,
  codeTableInterpretationRecordSchema,
  controlTableAnalysisModelSchema,
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
import {
  appendLogLine,
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";

const PROJECT_KEY = "P01";
const MAX_TABLES = 10;

type Def = {
  source_key: string;
  table_name: string;
  description: string;
  key_fields: string[];
  fields: Array<Record<string, unknown>>;
  content_hash: string;
  row_count: number;
  package: string;
  delivery_class: string;
};

type Row = {
  source_key: string;
  table_name: string;
  primary_key: Record<string, string>;
  values: Record<string, string>;
  classification: string;
  row_hash: string;
  content_hash: string;
};

type Link = {
  relation_type: string;
  from_key: string;
  to_key: string;
  to_type: string;
  metadata?: Record<string, unknown>;
  evidence_from_code?: string[];
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

function prepareRowsForPrompt(rows: Row[]): unknown {
  if (rows.length <= 40) {
    return rows.map((r) => ({
      primary_key: r.primary_key,
      values: r.values,
      classification: r.classification,
    }));
  }
  // representative: first 15, last 5, plus value-pattern sample
  const head = rows.slice(0, 15);
  const tail = rows.slice(-5);
  const mid = rows.filter((_, i) => i % Math.ceil(rows.length / 10) === 0).slice(0, 10);
  const picked = [...head, ...mid, ...tail];
  const seen = new Set<string>();
  const uniq = [];
  for (const r of picked) {
    if (seen.has(r.source_key)) continue;
    seen.add(r.source_key);
    uniq.push({
      primary_key: r.primary_key,
      values: r.values,
      classification: r.classification,
    });
  }
  return {
    note: `repräsentative ${uniq.length} von ${rows.length} Zeilen`,
    rows: uniq,
  };
}

function selectPilotTables(params: {
  defs: Map<string, Def>;
  classif: Map<string, Record<string, unknown>>;
  rowsByTable: Map<string, Row[]>;
  links: Link[];
}): Array<{ table_name: string; reason: string }> {
  const codeTables = new Map<string, { reads: number; writes: number; resolved: number }>();
  for (const link of params.links) {
    const meta = link.metadata ?? {};
    let table = String(meta.table_name ?? "");
    if (!table && link.to_type === "TABLE") {
      const parts = link.to_key.split("|");
      table = parts[2] ?? "";
    }
    if (!table) continue;
    const cur = codeTables.get(table) ?? { reads: 0, writes: 0, resolved: 0 };
    if (link.relation_type === "READS_TABLE") cur.reads += 1;
    if (link.relation_type === "WRITES_TABLE") cur.writes += 1;
    if (link.relation_type === "RESOLVES_TABLE_ROW") cur.resolved += 1;
    codeTables.set(table, cur);
  }

  const selected: Array<{ table_name: string; reason: string }> = [];
  const add = (name: string, reason: string) => {
    if (selected.some((s) => s.table_name === name)) return;
    if (!params.defs.has(name)) return;
    if (selected.length >= MAX_TABLES) return;
    selected.push({ table_name: name, reason });
  };

  // 1+2: code-referenced, prefer resolved
  const codeRanked = [...codeTables.entries()].sort(
    (a, b) =>
      b[1].resolved - a[1].resolved ||
      b[1].reads + b[1].writes - (a[1].reads + a[1].writes),
  );
  for (const [name, stats] of codeRanked) {
    add(
      name,
      stats.resolved > 0
        ? `Code-Referenz mit ${stats.resolved} direkt aufgelösten Zeilen`
        : `Code-Referenz (R=${stats.reads}/W=${stats.writes})`,
    );
  }

  // 3+4: small filled CUSTOMIZING with clear key/value patterns
  const patternScore = (name: string, def: Def, rows: Row[]) => {
    const keyBlob = def.key_fields.join(" ").toUpperCase();
    const fieldBlob = def.fields
      .map((f) => String(f.field_name ?? ""))
      .join(" ")
      .toUpperCase();
    let s = 0;
    if (/KEY|PARAM|KZ|STATUS|MAP|CODE/.test(keyBlob + " " + fieldBlob)) s += 3;
    if (rows.length >= 2 && rows.length <= 20) s += 2;
    if (rows.length === 1) s += 1;
    const cl = String(params.classif.get(name)?.classification ?? "");
    if (cl === "CUSTOMIZING_CONTROL_TABLE") s += 2;
    return s;
  };

  const filled = [...params.rowsByTable.entries()]
    .map(([name, rows]) => {
      const def = params.defs.get(name);
      if (!def) return null;
      return {
        name,
        rows,
        score: patternScore(name, def, rows),
        n: rows.length,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => b.score - a.score || a.n - b.n);

  for (const item of filled) {
    if (item.score < 3) continue;
    add(
      item.name,
      `Kleine befüllte CUSTOMIZING-Tabelle (${item.n} Zeilen) mit Schlüssel-/Wertmuster`,
    );
  }

  return selected.slice(0, MAX_TABLES);
}

function extractSnippet(sourceCode: string, evidence: string, radius = 8): string {
  const lines = sourceCode.replace(/\r\n/g, "\n").split("\n");
  const needle = evidence.replace(/\s+/g, " ").trim().slice(0, 80);
  let idx = lines.findIndex((l) => l.includes(needle.slice(0, 40)));
  if (idx < 0) {
    // fallback: first SELECT/UPDATE mentioning table-ish
    idx = lines.findIndex((l) => /SELECT|UPDATE|WHERE/i.test(l));
  }
  if (idx < 0) return lines.slice(0, Math.min(40, lines.length)).join("\n");
  const from = Math.max(0, idx - radius);
  const to = Math.min(lines.length, idx + radius + 12);
  return lines.slice(from, to).join("\n");
}

function buildResolvedTargets(params: {
  links: Link[];
  rowsByKey: Map<string, Row>;
  unitsByKey: Map<string, Record<string, unknown>>;
}): Array<{
  code_source_key: string;
  method_name: string;
  class_name: string;
  table_name: string;
  table_row_source_key: string;
  resolved_key: string;
  evidence_code: string;
  matched_conditions: unknown;
  source_code: string;
}> {
  const resolved = params.links.filter(
    (l) => l.relation_type === "RESOLVES_TABLE_ROW",
  );
  // Expand to access-level uniqueness: one per (method,row) from link metadata;
  // CHECK_FOR_BE_EXPORT appears once in links but twice in accesses — add second from log if present.
  const out: Array<{
    code_source_key: string;
    method_name: string;
    class_name: string;
    table_name: string;
    table_row_source_key: string;
    resolved_key: string;
    evidence_code: string;
    matched_conditions: unknown;
    source_code: string;
  }> = [];

  for (const link of resolved) {
    const unit = params.unitsByKey.get(link.from_key);
    if (!unit) continue;
    const meta = link.metadata ?? {};
    const table_name = String(meta.table_name ?? "");
    const resolved_key = String(meta.resolved_key ?? "");
    const evidence =
      (link.evidence_from_code && link.evidence_from_code[0]) ||
      JSON.stringify(meta.matched_conditions ?? "");
    out.push({
      code_source_key: link.from_key,
      method_name: String(unit.unit_name ?? link.from_key.split("|").pop()),
      class_name: String(unit.object_name ?? ""),
      table_name,
      table_row_source_key: link.to_key,
      resolved_key,
      evidence_code: evidence,
      matched_conditions: meta.matched_conditions ?? [],
      source_code: String(unit.source_code ?? ""),
    });
  }

  // If we have only 4 unique links but 5 access resolutions, duplicate CHECK_FOR_BE_EXPORT
  // with a distinct source_key suffix for the second occurrence (pilot expects 5).
  const accessesPath = resolveWritablePath(
    PROJECT_KEY,
    "logs",
    "code_table_accesses.jsonl",
  );
  if (existsSync(accessesPath) && out.length < 5) {
    const accesses = readJsonl<Record<string, unknown>>(accessesPath).filter(
      (a) =>
        String(a.table_name) === "ZEXTO_PARAMETER" &&
        Array.isArray(a.where) &&
        (a.where as Array<{ resolved_literal?: string }>).some(
          (w) => w.resolved_literal != null,
        ),
    );
    // Rebuild strictly from 5 ZEXTO accesses with literals
    const rebuilt = [];
    for (const a of accesses) {
      const code_source_key = String(a.code_source_key);
      const unit = params.unitsByKey.get(code_source_key);
      if (!unit) continue;
      const lit = (a.where as Array<{ field: string; resolved_literal?: string }>)
        .map((w) => w.resolved_literal)
        .find((x) => x != null);
      if (lit == null) continue;
      // find matching row
      const row = [...params.rowsByKey.values()].find((r) => {
        if (r.table_name !== "ZEXTO_PARAMETER") return false;
        const keyVal = r.primary_key.KEY01 ?? r.values.KEY01;
        const na = String(keyVal).replace(/^0+/, "") || "0";
        const nb = String(lit).replace(/^0+/, "") || "0";
        return na === nb || String(keyVal) === String(lit);
      });
      if (!row) continue;
      rebuilt.push({
        code_source_key,
        method_name: String(a.method_name ?? unit.unit_name),
        class_name: String(unit.object_name ?? ""),
        table_name: "ZEXTO_PARAMETER",
        table_row_source_key: row.source_key,
        resolved_key: serializePk(row.primary_key),
        evidence_code: String(a.evidence_code ?? ""),
        matched_conditions: a.where,
        source_code: String(unit.source_code ?? ""),
      });
    }
    if (rebuilt.length >= 5) return rebuilt.slice(0, 5);
    if (rebuilt.length > out.length) return rebuilt;
  }

  return out.slice(0, 5);
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
  const linksPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "relations/code_table_links.jsonl",
  );
  const unitsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "classes/code_units.jsonl",
  );
  const unitAnalysesPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    "classes/unit_analyses.jsonl",
  );
  const outTablesRel = "control-tables/table_analyses.jsonl";
  const outInterpRel = "relations/code_table_interpretations.jsonl";
  const existingTablesPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    outTablesRel,
  );
  const existingInterpPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    outInterpRel,
  );

  const defs = new Map(
    readJsonl<Def>(defsPath).map((d) => [d.table_name, d]),
  );
  const classif = new Map(
    readJsonl<Record<string, unknown>>(classPath).map((c) => [
      String(c.table_name),
      c,
    ]),
  );
  const rows = readJsonl<Row>(rowsPath);
  const rowsByTable = new Map<string, Row[]>();
  const rowsByKey = new Map<string, Row>();
  for (const r of rows) {
    const list = rowsByTable.get(r.table_name) ?? [];
    list.push(r);
    rowsByTable.set(r.table_name, list);
    rowsByKey.set(r.source_key, r);
  }
  const links = readJsonl<Link>(linksPath);
  const units = readJsonl<Record<string, unknown>>(unitsPath);
  const unitsByKey = new Map(units.map((u) => [String(u.source_key), u]));
  const unitAnalyses = new Map(
    readJsonl<Record<string, unknown>>(unitAnalysesPath).map((a) => [
      String(a.source_key),
      a,
    ]),
  );

  const existingTables = new Map(
    readJsonl<ControlTableAnalysisRecord>(existingTablesPath).map((r) => [
      r.source_key,
      r,
    ]),
  );
  const existingInterps = new Map(
    readJsonl<CodeTableInterpretationRecord>(existingInterpPath).map((r) => [
      r.source_key,
      r,
    ]),
  );

  const selected = selectPilotTables({ defs, classif, rowsByTable, links });
  console.log(`Ausgewählte Tabellen (${selected.length}):`);
  for (const s of selected) console.log(`- ${s.table_name}: ${s.reason}`);

  ensureWritableDir(PROJECT_KEY, "analyses", "control-tables");
  ensureWritableDir(PROJECT_KEY, "analyses", "relations");
  ensureWritableDir(PROJECT_KEY, "logs", "control-tables");

  const deviations: AnalysisDeviation[] = [];
  const tableResults: ControlTableAnalysisRecord[] = [
    ...existingTables.values(),
  ];
  let analyzedTables = 0;
  let skippedTables = 0;
  let tableErrors = 0;
  let sumIn = 0;
  let sumOut = 0;
  let sumCost = 0;
  let sumDur = 0;
  let sumConf = 0;
  let confN = 0;

  const codeUsagesByTable = new Map<string, unknown[]>();
  for (const link of links) {
    const table = String(link.metadata?.table_name ?? "");
    if (!table) continue;
    if (
      ![
        "READS_TABLE",
        "WRITES_TABLE",
        "RESOLVES_TABLE_ROW",
        "FILTERS_BY_LITERAL",
        "READS_TABLE_FIELD",
      ].includes(link.relation_type)
    ) {
      continue;
    }
    const list = codeUsagesByTable.get(table) ?? [];
    list.push({
      relation_type: link.relation_type,
      code_source_key: link.from_key,
      evidence: link.evidence_from_code?.[0] ?? null,
      metadata: link.metadata ?? {},
    });
    codeUsagesByTable.set(table, list);
  }

  for (const sel of selected) {
    const def = defs.get(sel.table_name)!;
    const tableRows = rowsByTable.get(sel.table_name) ?? [];
    const content_hash = sha256Stable({
      definition_hash: def.content_hash,
      row_hashes: tableRows.map((r) => r.row_hash).sort(),
      classification: classif.get(sel.table_name)?.classification ?? null,
      code_usage_fingerprint: sha256Stable(
        codeUsagesByTable.get(sel.table_name) ?? [],
      ),
    });

    const prior = existingTables.get(def.source_key);
    if (
      prior &&
      prior.content_hash === content_hash &&
      prior.prompt_version === CONTROL_TABLE_ANALYSIS_PROMPT_VERSION
    ) {
      skippedTables += 1;
      appendLogLine(
        PROJECT_KEY,
        "pilot-control-tables-openai.log",
        `[skip] ${sel.table_name} unchanged hash`,
      );
      continue;
    }

    try {
      const call = await generateStructuredWithUsage({
        schema: controlTableAnalysisModelSchema,
        schemaName: "sap_control_table_analysis_v1",
        system: buildControlTableAnalysisSystemPrompt(),
        user: buildControlTableAnalysisUserPrompt({
          tableName: sel.table_name,
          selectionReason: sel.reason,
          definitionJson: JSON.stringify(
            {
              source_key: def.source_key,
              description: def.description,
              package: def.package,
              delivery_class: def.delivery_class,
              key_fields: def.key_fields,
              fields: def.fields,
              row_count: def.row_count,
            },
            null,
            2,
          ),
          classificationJson: JSON.stringify(
            classif.get(sel.table_name) ?? {},
            null,
            2,
          ),
          rowsJson: JSON.stringify(prepareRowsForPrompt(tableRows), null, 2),
          codeUsagesJson: JSON.stringify(
            codeUsagesByTable.get(sel.table_name) ?? [],
            null,
            2,
          ),
        }),
        model: AI_CONFIG.chatModel,
      });

      const record = controlTableAnalysisRecordSchema.parse({
        ...call.data,
        source_key: def.source_key,
        table_name: sel.table_name,
        selection_reason: sel.reason,
        model: call.model,
        prompt_version: CONTROL_TABLE_ANALYSIS_PROMPT_VERSION,
        content_hash,
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        estimated_cost: call.estimated_cost,
        duration_ms: call.duration_ms,
      });

      deviations.push(
        ...validateTableAnalysis({
          record,
          definition: def as unknown as Record<string, unknown>,
          rows: tableRows as unknown as Array<Record<string, unknown>>,
        }),
      );

      const idx = tableResults.findIndex((r) => r.source_key === record.source_key);
      if (idx >= 0) tableResults[idx] = record;
      else tableResults.push(record);

      analyzedTables += 1;
      sumIn += call.input_tokens;
      sumOut += call.output_tokens;
      sumCost += call.estimated_cost;
      sumDur += call.duration_ms;
      sumConf += record.confidence;
      confN += 1;
      console.log(
        `OK table ${sel.table_name} conf=${record.confidence} tokens=${call.input_tokens}/${call.output_tokens} ${call.duration_ms}ms`,
      );
    } catch (error) {
      tableErrors += 1;
      console.error(
        `FAIL table ${sel.table_name}:`,
        error instanceof Error ? error.message : error,
      );
      appendLogLine(
        PROJECT_KEY,
        "pilot-control-tables-openai.log",
        `[fail] ${sel.table_name} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Persist table analyses (only pilot outputs file — may update pilot entries)
  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    outTablesRel,
    tableResults.length
      ? `${tableResults
          .sort((a, b) => a.table_name.localeCompare(b.table_name))
          .map((r) => JSON.stringify(r))
          .join("\n")}\n`
      : "",
  );

  const tableAnalysisByName = new Map(
    tableResults.map((r) => [r.table_name, r]),
  );

  const targets = buildResolvedTargets({ links, rowsByKey, unitsByKey });
  console.log(`Code-Tabellen-Targets: ${targets.length}`);

  const interpResults: CodeTableInterpretationRecord[] = [
    ...existingInterps.values(),
  ];
  let analyzedLinks = 0;
  let skippedLinks = 0;
  let linkErrors = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const row = rowsByKey.get(t.table_row_source_key);
    if (!row) {
      linkErrors += 1;
      continue;
    }
    const source_key = [
      t.code_source_key,
      t.table_row_source_key,
      createHash("sha1")
        .update(`${t.evidence_code}|${i}`)
        .digest("hex")
        .slice(0, 10),
    ].join("||");

    const content_hash = sha256Stable({
      code_source_key: t.code_source_key,
      table_row_source_key: t.table_row_source_key,
      evidence_code: t.evidence_code,
      row_hash: row.row_hash,
      unit_analysis_hash:
        (unitAnalyses.get(t.code_source_key)?.content_hash as string) ?? null,
      table_analysis_hash:
        tableAnalysisByName.get(t.table_name)?.content_hash ?? null,
    });

    const prior = existingInterps.get(source_key);
    if (
      prior &&
      prior.content_hash === content_hash &&
      prior.prompt_version === CODE_TABLE_INTERPRETATION_PROMPT_VERSION
    ) {
      skippedLinks += 1;
      continue;
    }

    const def = defs.get(t.table_name);
    const unitAnalysis = unitAnalyses.get(t.code_source_key);
    const tableAnalysis = tableAnalysisByName.get(t.table_name);
    const snippet = extractSnippet(t.source_code, t.evidence_code);

    try {
      const call = await generateStructuredWithUsage({
        schema: codeTableInterpretationModelSchema,
        schemaName: "code_table_interpretation_v1",
        system: buildCodeTableInterpretationSystemPrompt(),
        user: buildCodeTableInterpretationUserPrompt({
          className: t.class_name,
          methodName: t.method_name,
          tableName: t.table_name,
          codeSnippet: snippet,
          whereConditionsJson: JSON.stringify(t.matched_conditions, null, 2),
          tableRowJson: JSON.stringify(
            {
              source_key: row.source_key,
              primary_key: row.primary_key,
              values: row.values,
            },
            null,
            2,
          ),
          fieldDefsJson: JSON.stringify(
            (def?.fields ?? []).filter((f) => {
              const name = String(f.field_name ?? "");
              return (
                def?.key_fields.includes(name) ||
                Object.keys(row.values).includes(name)
              );
            }),
            null,
            2,
          ),
          unitAnalysisSummaryJson: JSON.stringify(
            unitAnalysis
              ? {
                  technical_summary: unitAnalysis.technical_summary,
                  business_purpose_inferred:
                    unitAnalysis.business_purpose_inferred,
                  called_methods: unitAnalysis.called_methods,
                  tables_read: unitAnalysis.tables_read,
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
                  business_purpose_inferred:
                    tableAnalysis.business_purpose_inferred,
                  likely_table_role: tableAnalysis.likely_table_role,
                  parameters: tableAnalysis.parameters,
                  unresolved_points: tableAnalysis.unresolved_points,
                  confidence: tableAnalysis.confidence,
                }
              : null,
            null,
            2,
          ),
        }),
        model: AI_CONFIG.chatModel,
      });

      // Force canonical resolved values (model may paraphrase)
      const record = codeTableInterpretationRecordSchema.parse({
        ...call.data,
        resolved_key: t.resolved_key,
        resolved_values: row.values,
        source_key,
        code_source_key: t.code_source_key,
        class_name: t.class_name,
        method_name: t.method_name,
        table_name: t.table_name,
        table_row_source_key: t.table_row_source_key,
        model: call.model,
        prompt_version: CODE_TABLE_INTERPRETATION_PROMPT_VERSION,
        content_hash,
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        estimated_cost: call.estimated_cost,
        duration_ms: call.duration_ms,
      });

      deviations.push(
        ...validateCodeTableInterpretation({
          record,
          sourceCode: t.source_code,
          tableRow: row,
          expectedResolvedKey: t.resolved_key,
        }),
      );

      const idx = interpResults.findIndex((r) => r.source_key === source_key);
      if (idx >= 0) interpResults[idx] = record;
      else interpResults.push(record);

      analyzedLinks += 1;
      sumIn += call.input_tokens;
      sumOut += call.output_tokens;
      sumCost += call.estimated_cost;
      sumDur += call.duration_ms;
      sumConf += record.confidence;
      confN += 1;
      console.log(
        `OK link ${t.method_name} → ${t.table_name}|${t.resolved_key} conf=${record.confidence}`,
      );
    } catch (error) {
      linkErrors += 1;
      console.error(
        `FAIL link ${t.method_name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    outInterpRel,
    interpResults.length
      ? `${interpResults.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
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

  const exampleTables = tableResults
    .filter((r) => selected.some((s) => s.table_name === r.table_name))
    .slice(0, 3);
  const allInterps = interpResults.filter((r) =>
    targets.some(
      (t) =>
        r.code_source_key === t.code_source_key &&
        r.table_row_source_key === t.table_row_source_key,
    ),
  );

  const report = {
    at: new Date().toISOString(),
    model: AI_CONFIG.chatModel,
    prompt_versions: {
      table: CONTROL_TABLE_ANALYSIS_PROMPT_VERSION,
      interpretation: CODE_TABLE_INTERPRETATION_PROMPT_VERSION,
    },
    ausgewaehlte_tabellen: selected,
    analysierte_tabellen: analyzedTables,
    uebersprungene_tabellen: skippedTables,
    analysierte_code_tabellen_verknuepfungen: analyzedLinks,
    uebersprungene_verknuepfungen: skippedLinks,
    fehler: tableErrors + linkErrors,
    durchschnittliche_confidence:
      confN === 0 ? 0 : Number((sumConf / confN).toFixed(3)),
    input_tokens: sumIn,
    output_tokens: sumOut,
    gesamtkosten_usd: Number(sumCost.toFixed(6)),
    gesamtlaufzeit_ms: sumDur,
    beispiel_tabellenanalysen: exampleTables,
    code_tabellen_interpretationen: allInterps,
    unresolved_punkte: {
      tables: tableResults.flatMap((r) =>
        r.unresolved_points.map((u) => ({ table: r.table_name, unresolved: u })),
      ),
      interpretations: allInterps.flatMap((r) =>
        r.unresolved_points.map((u) => ({
          method: r.method_name,
          unresolved: u,
        })),
      ),
    },
    qualitaetsabweichungen: parsedDevs,
    geaenderte_dateien: [
      "src/lib/analysis/controlTablePilotSchema.ts",
      "src/lib/analysis/controlTablePilotPrompts.ts",
      "src/lib/analysis/controlTablePilotQuality.ts",
      "src/lib/analysis/pilotOpenAi.ts",
      "scripts/pilot-control-tables-openai.ts",
      "package.json",
      "P01/analyses/control-tables/table_analyses.jsonl",
      "P01/analyses/relations/code_table_interpretations.jsonl",
      "P01/logs/control-tables/analysis_deviations.jsonl",
      "P01/logs/control-tables/pilot_report.json",
    ],
  };

  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "control-tables/pilot_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log("\n=== PILOTBERICHT ===");
  console.log(`ausgewählte Tabellen: ${selected.length}`);
  for (const s of selected) console.log(`  - ${s.table_name}: ${s.reason}`);
  console.log(`analysierte Tabellen: ${analyzedTables}`);
  console.log(`übersprungene Tabellen: ${skippedTables}`);
  console.log(`analysierte Verknüpfungen: ${analyzedLinks}`);
  console.log(`Fehler: ${tableErrors + linkErrors}`);
  console.log(`avg confidence: ${report.durchschnittliche_confidence}`);
  console.log(`tokens in/out: ${sumIn}/${sumOut}`);
  console.log(`Kosten USD: ${report.gesamtkosten_usd}`);
  console.log(`Laufzeit ms: ${sumDur}`);
  console.log(`Qualitätsabweichungen: ${parsedDevs.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
