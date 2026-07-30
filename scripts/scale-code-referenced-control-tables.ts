/**
 * Scale: all code-referenced control tables + all direct code-table resolutions.
 * No full estate (285), no embeddings, no architecture changes.
 *
 *   npm run scale:code-referenced-control-tables
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  buildCodeTableInterpretationSystemPrompt,
  buildCodeTableInterpretationUserPrompt,
  buildControlTableAnalysisSystemPrompt,
  buildControlTableAnalysisUserPrompt,
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
  matchRowsForAccess,
  type CodeTableAccess,
} from "../src/lib/analysis/codeTableLinkExtract";
import {
  generateStructuredWithUsage,
  sha256Stable,
} from "../src/lib/analysis/pilotOpenAi";
import { AI_CONFIG } from "../src/lib/ai/config";
import type {
  CanonicalTableDefinition,
  CanonicalTableRow,
} from "../src/lib/ingest/controlTables/model";
import { serializeCanonicalPrimaryKey } from "../src/lib/ingest/controlTables/model";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";

const PROJECT_KEY = "P01";

type Def = CanonicalTableDefinition & {
  content_hash: string;
  row_count: number;
  package: string;
  delivery_class: string;
  fields: Array<Record<string, unknown>>;
};

type Row = CanonicalTableRow & {
  row_hash: string;
  content_hash: string;
  classification?: string;
};

type Link = {
  relation_type: string;
  from_key: string;
  to_key: string;
  to_type: string;
  metadata?: Record<string, unknown>;
  evidence_from_code?: string[];
};

type ReferencedTable = {
  table_name: string;
  classification: string;
  row_count: number;
  code_unit_count: number;
  read_count: number;
  write_count: number;
  direct_row_resolution_count: number;
  candidate_resolution_count: number;
  dynamic_access_count: number;
  priority_score: number;
  selection_reasons: string[];
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

function tableNameFromLink(link: Link): string | null {
  const meta = link.metadata ?? {};
  if (typeof meta.table_name === "string" && meta.table_name) {
    return meta.table_name;
  }
  if (link.to_type === "TABLE") {
    const parts = link.to_key.split("|");
    return parts[2] ?? null;
  }
  if (link.to_type === "TABLE_ROW") {
    const parts = link.to_key.split("|");
    return parts[2] ?? null;
  }
  if (link.to_type === "FIELD" && link.to_key.includes(".")) {
    return link.to_key.split(".")[0] ?? null;
  }
  return null;
}

function prepareRowsForCodeReferenced(params: {
  rows: Row[];
  resolvedRowKeys: Set<string>;
}): { payload: unknown; sampling_note: string } {
  const { rows, resolvedRowKeys } = params;
  if (rows.length <= 40) {
    return {
      payload: rows.map((r) => ({
        source_key: r.source_key,
        primary_key: r.primary_key,
        values: r.values,
        classification: r.classification,
        selected_because: resolvedRowKeys.has(r.source_key)
          ? "code_resolved"
          : "full_small_table",
      })),
      sampling_note: `vollständig (${rows.length} Zeilen)`,
    };
  }

  const resolved = rows.filter((r) => resolvedRowKeys.has(r.source_key));
  const rest = rows.filter((r) => !resolvedRowKeys.has(r.source_key));

  // Group by first non-MANDT key field value prefix / fingerprint of value fields
  const groups = new Map<string, Row[]>();
  for (const r of rest) {
    const pkEntries = Object.entries(r.primary_key).filter(
      ([k]) => k.toUpperCase() !== "MANDT",
    );
    const keyPat = pkEntries
      .map(([k, v]) => `${k}:${String(v).slice(0, 12)}`)
      .join("|");
    const valPat = Object.entries(r.values)
      .filter(([k]) => !(k in r.primary_key))
      .map(([k, v]) => `${k}:${String(v).slice(0, 8)}`)
      .slice(0, 4)
      .join("|");
    const gkey = `${keyPat}||${valPat}` || "other";
    const list = groups.get(gkey) ?? [];
    list.push(r);
    groups.set(gkey, list);
  }

  const samples: unknown[] = resolved.map((r) => ({
    source_key: r.source_key,
    primary_key: r.primary_key,
    values: r.values,
    selected_because: "code_resolved",
  }));

  const groupSamples: Array<{ pattern: string; count: number; example: unknown }> =
    [];
  for (const [pattern, list] of [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    if (groupSamples.length >= 25) break;
    const ex = list[0]!;
    groupSamples.push({
      pattern,
      count: list.length,
      example: {
        source_key: ex.source_key,
        primary_key: ex.primary_key,
        values: ex.values,
      },
    });
    samples.push({
      source_key: ex.source_key,
      primary_key: ex.primary_key,
      values: ex.values,
      selected_because: `pattern_group:${pattern}`,
      group_size: list.length,
    });
  }

  // head/tail safety net
  for (const r of [...rest.slice(0, 5), ...rest.slice(-3)]) {
    if (samples.some((s) => (s as { source_key?: string }).source_key === r.source_key)) {
      continue;
    }
    samples.push({
      source_key: r.source_key,
      primary_key: r.primary_key,
      values: r.values,
      selected_because: "head_tail_sample",
    });
  }

  return {
    payload: {
      note: `repräsentativ ${samples.length} von ${rows.length}; resolved=${resolved.length}; gruppen=${groupSamples.length}`,
      resolved_rows: resolved.length,
      pattern_groups: groupSamples.slice(0, 15),
      rows: samples,
    },
    sampling_note: `sampled ${samples.length}/${rows.length} (resolved=${resolved.length}, groups=${groupSamples.length})`,
  };
}

function priorityScore(t: Omit<ReferencedTable, "priority_score" | "selection_reasons">): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;
  if (t.direct_row_resolution_count > 0) {
    score += 100 * t.direct_row_resolution_count;
    reasons.push(`direkt aufgelöste Zeilen (${t.direct_row_resolution_count})`);
  }
  if (t.read_count > 0 || t.write_count > 0) {
    score += 10 * (t.read_count + t.write_count);
    reasons.push(`Read/Write-Verwendung (R=${t.read_count}/W=${t.write_count})`);
  }
  if (t.code_unit_count > 1) {
    score += 5 * t.code_unit_count;
    reasons.push(`mehrere Code Units (${t.code_unit_count})`);
  } else if (t.code_unit_count === 1) {
    score += 2;
    reasons.push("mindestens eine Code Unit");
  }
  if (t.row_count > 0) {
    score += 3;
    reasons.push(`befüllte Tabelle (${t.row_count} Zeilen)`);
  }
  if (t.classification === "CUSTOMIZING_CONTROL_TABLE") {
    score += 2;
    reasons.push("CUSTOMIZING_CONTROL_TABLE");
  } else if (t.classification === "REVIEW_CANDIDATE") {
    score += 1;
    reasons.push("REVIEW_CANDIDATE");
  }
  if (t.candidate_resolution_count > 0) {
    score += 20 * t.candidate_resolution_count;
    reasons.push(`Kandidatenauflösung (${t.candidate_resolution_count})`);
  }
  if (t.dynamic_access_count > 0) {
    score += 5 * t.dynamic_access_count;
    reasons.push(`dynamische Zugriffe (${t.dynamic_access_count})`);
  }
  if (reasons.length === 0) reasons.push("code-referenziert");
  return { score, reasons };
}

function formatLine(l: { line: number; text: string }): string {
  return `L${l.line}|${l.text}`;
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
  const existingTablesPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    "control-tables/table_analyses.jsonl",
  );
  const existingInterpPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    "relations/code_table_interpretations.jsonl",
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
  const allRows = readJsonl<Row>(rowsPath);
  const rowsByTable = new Map<string, Row[]>();
  const rowsByKey = new Map<string, Row>();
  for (const r of allRows) {
    const list = rowsByTable.get(r.table_name) ?? [];
    list.push(r);
    rowsByTable.set(r.table_name, list);
    rowsByKey.set(r.source_key, r);
  }
  const links = readJsonl<Link>(linksPath);
  const accesses = readJsonl<CodeTableAccess>(accessesPath);
  const unitsByKey = new Map(
    readJsonl<Record<string, unknown>>(unitsPath).map((u) => [
      String(u.source_key),
      u,
    ]),
  );
  const unitAnalyses = new Map(
    readJsonl<Record<string, unknown>>(unitAnalysesPath).map((a) => [
      String(a.source_key),
      a,
    ]),
  );

  // --- Classify each access ---
  type Classified = {
    access: CodeTableAccess;
    kind: "resolved" | "candidate" | "dynamic";
    resolved?: Row;
    candidates: Row[];
    matchedConditions: Array<{ field: string; value: string }>;
    occurrence_index: number;
  };

  const occCounter = new Map<string, number>();
  const classified: Classified[] = [];
  for (const access of accesses) {
    const def = defs.get(access.table_name);
    const match = matchRowsForAccess({
      access,
      definition: def,
      rows: rowsByTable.get(access.table_name) ?? [],
      client: def?.client ?? "001",
    });
    const occKey = `${access.code_source_key}||${access.evidence_code}`;
    const occurrence_index = occCounter.get(occKey) ?? 0;
    occCounter.set(occKey, occurrence_index + 1);

    if (match.resolved.length === 1) {
      classified.push({
        access,
        kind: "resolved",
        resolved: match.resolved[0] as Row,
        candidates: [],
        matchedConditions: match.matchedConditions,
        occurrence_index,
      });
    } else if (match.candidates.length > 0) {
      classified.push({
        access,
        kind: "candidate",
        candidates: match.candidates as Row[],
        matchedConditions: match.matchedConditions,
        occurrence_index,
      });
    } else {
      classified.push({
        access,
        kind: "dynamic",
        candidates: [],
        matchedConditions: match.matchedConditions,
        occurrence_index,
      });
    }
  }

  // --- Inventory of code-referenced tables ---
  const tableNames = new Set<string>();
  for (const link of links) {
    const t = tableNameFromLink(link);
    if (t) tableNames.add(t);
  }
  for (const a of accesses) tableNames.add(a.table_name);

  const inventory: ReferencedTable[] = [];
  for (const table_name of tableNames) {
    const def = defs.get(table_name);
    if (!def) continue;
    const cl = String(classif.get(table_name)?.classification ?? "UNKNOWN");
    const tableAccesses = classified.filter(
      (c) => c.access.table_name === table_name,
    );
    const units = new Set(tableAccesses.map((c) => c.access.code_source_key));
    // also units from links
    for (const link of links) {
      if (tableNameFromLink(link) === table_name) units.add(link.from_key);
    }
    const base = {
      table_name,
      classification: cl,
      row_count: def.row_count ?? (rowsByTable.get(table_name)?.length ?? 0),
      code_unit_count: units.size,
      read_count: tableAccesses.filter((c) => c.access.access_kind === "READ")
        .length,
      write_count: tableAccesses.filter((c) => c.access.access_kind === "WRITE")
        .length,
      direct_row_resolution_count: tableAccesses.filter(
        (c) => c.kind === "resolved",
      ).length,
      candidate_resolution_count: tableAccesses.filter(
        (c) => c.kind === "candidate",
      ).length,
      dynamic_access_count: tableAccesses.filter((c) => c.kind === "dynamic")
        .length,
    };
    const { score, reasons } = priorityScore(base);
    inventory.push({
      ...base,
      priority_score: score,
      selection_reasons: reasons,
    });
  }
  inventory.sort(
    (a, b) =>
      b.priority_score - a.priority_score ||
      a.table_name.localeCompare(b.table_name),
  );

  ensureWritableDir(PROJECT_KEY, "logs", "control-tables");
  ensureWritableDir(PROJECT_KEY, "analyses", "control-tables");
  ensureWritableDir(PROJECT_KEY, "analyses", "relations");

  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "control-tables/code_referenced_tables.json",
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        count: inventory.length,
        tables: inventory,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Code-referenzierte Tabellen: ${inventory.length}`);
  for (const t of inventory) {
    console.log(
      `  - ${t.table_name} score=${t.priority_score} R=${t.read_count} W=${t.write_count} resolved=${t.direct_row_resolution_count} dyn=${t.dynamic_access_count}`,
    );
  }

  // --- Candidates + dynamic files (no OpenAI) ---
  const candidateRecords = classified
    .filter((c) => c.kind === "candidate")
    .map((c) => {
      const unresolved = (c.access.where ?? [])
        .filter((w) => w.value_kind === "variable" && w.resolved_literal == null)
        .map((w) => w.raw_value);
      return {
        code_source_key: c.access.code_source_key,
        method_name: c.access.method_name,
        table_name: c.access.table_name,
        known_conditions: c.matchedConditions,
        unresolved_variables: unresolved,
        candidate_rows: c.candidates.slice(0, 20).map((r) => ({
          source_key: r.source_key,
          primary_key: r.primary_key,
        })),
        candidate_count: c.candidates.length,
        confidence: Math.max(0.2, Math.min(0.7, 1 / Math.max(1, c.candidates.length))),
        missing_information: unresolved.map(
          (v) => `Literalwert für Variable ${v} zur Laufzeit unbekannt`,
        ),
        recommended_next_step:
          "Laufzeit-/Trace-Werte für unresolved_variables erfassen oder Deterministik erweitern — keine freie KI-Auflösung",
        evidence_code: c.access.evidence_code,
        access_kind: c.access.access_kind,
        line_start: c.access.line_start,
      };
    });

  const dynamicRecords = classified
    .filter((c) => c.kind === "dynamic")
    .map((c) => {
      const vars = (c.access.where ?? []).filter(
        (w) => w.value_kind === "variable" && w.resolved_literal == null,
      );
      return {
        code_source_key: c.access.code_source_key,
        method_name: c.access.method_name,
        table_name: c.access.table_name,
        table_expression: c.access.table_name,
        variable_source: vars.map((v) => ({
          field: v.field,
          variable: v.raw_value,
        })),
        known_value_flow: (c.access.where ?? [])
          .filter((w) => w.resolved_literal != null)
          .map((w) => ({ field: w.field, literal: w.resolved_literal })),
        unresolved_reason:
          vars.length > 0
            ? "WHERE-Bedingungen an unresolved Variablen gebunden; keine eindeutige Zeile deterministisch ableitbar"
            : "Keine auflösbaren Equality-Literale in WHERE",
        evidence: [c.access.evidence_code],
        recommended_resolution_strategy:
          "Datenflussanalyse / Laufzeitwerte für Variablen; optional später gezielte KI nur mit belegtem Kontext",
        access_kind: c.access.access_kind,
        line_start: c.access.line_start,
        into_target: c.access.into_target,
      };
    });

  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "relations/code_table_resolution_candidates.jsonl",
    candidateRecords.length
      ? `${candidateRecords.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
  );
  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "relations/dynamic_table_accesses.jsonl",
    dynamicRecords.length
      ? `${dynamicRecords.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
  );
  console.log(
    `Kandidaten: ${candidateRecords.length}, dynamische Zugriffe: ${dynamicRecords.length}`,
  );

  // --- Existing analyses ---
  const existingTables = new Map(
    readJsonl<ControlTableAnalysisRecord>(existingTablesPath).map((r) => [
      r.source_key,
      r,
    ]),
  );
  const existingInterpsByKey = new Map(
    readJsonl<
      CodeTableInterpretationRecord & {
        access_id?: string;
        business_rule_id?: string;
      }
    >(existingInterpPath).map((r) => [r.source_key, r]),
  );
  const existingInterpsByAccess = new Map<
    string,
    CodeTableInterpretationRecord & {
      access_id?: string;
      business_rule_id?: string;
    }
  >();
  for (const r of existingInterpsByKey.values()) {
    if (r.access_id) existingInterpsByAccess.set(r.access_id, r);
  }

  const codeUsagesByTable = new Map<string, unknown[]>();
  for (const link of links) {
    const table = tableNameFromLink(link);
    if (!table) continue;
    if (
      ![
        "READS_TABLE",
        "WRITES_TABLE",
        "RESOLVES_TABLE_ROW",
        "FILTERS_BY_LITERAL",
        "READS_TABLE_FIELD",
        "RESOLVES_TABLE_ROW_CANDIDATE",
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

  const resolvedKeysByTable = new Map<string, Set<string>>();
  for (const c of classified) {
    if (c.kind !== "resolved" || !c.resolved) continue;
    const set = resolvedKeysByTable.get(c.access.table_name) ?? new Set();
    set.add(c.resolved.source_key);
    resolvedKeysByTable.set(c.access.table_name, set);
  }

  let analyzedTables = 0;
  let skippedTables = 0;
  let tableErrors = 0;
  let sumIn = 0;
  let sumOut = 0;
  let sumCost = 0;
  let sumDur = 0;
  const deviations: AnalysisDeviation[] = [];
  const samplingNotes: Record<string, string> = {};

  const tableResults = new Map(existingTables);

  for (const ref of inventory) {
    const def = defs.get(ref.table_name)!;
    const tableRows = rowsByTable.get(ref.table_name) ?? [];
    const content_hash = sha256Stable({
      definition_hash: def.content_hash,
      row_hashes: tableRows.map((r) => r.row_hash).sort(),
      classification: classif.get(ref.table_name)?.classification ?? null,
      code_usage_fingerprint: sha256Stable(
        codeUsagesByTable.get(ref.table_name) ?? [],
      ),
    });

    const prior = existingTables.get(def.source_key);
    if (
      prior &&
      prior.content_hash === content_hash &&
      prior.prompt_version === CONTROL_TABLE_ANALYSIS_PROMPT_VERSION
    ) {
      skippedTables += 1;
      // Soft-harden evidence refs without changing content_hash / model fields
      const hardened = hardenTableAnalysisEvidence({
        record: prior,
        definition: {
          source_key: def.source_key,
          description: def.description,
          table_name: ref.table_name,
        },
        rows: tableRows,
        classification: classif.get(ref.table_name) as
          | { classification?: string }
          | undefined,
      });
      // Keep prior as-is for idempotency of hash — only replace if identical hash
      tableResults.set(def.source_key, prior);
      console.log(`SKIP table ${ref.table_name} (unchanged hash)`);
      void hardened;
      continue;
    }

    const prepared = prepareRowsForCodeReferenced({
      rows: tableRows,
      resolvedRowKeys: resolvedKeysByTable.get(ref.table_name) ?? new Set(),
    });
    samplingNotes[ref.table_name] = prepared.sampling_note;

    try {
      console.log(`ANALYZE table ${ref.table_name} (${prepared.sampling_note})`);
      const call = await generateStructuredWithUsage({
        schema: controlTableAnalysisModelSchema,
        schemaName: "sap_control_table_analysis_v1",
        system: buildControlTableAnalysisSystemPrompt(),
        user: buildControlTableAnalysisUserPrompt({
          tableName: ref.table_name,
          selectionReason: ref.selection_reasons.join("; "),
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
            classif.get(ref.table_name) ?? {},
            null,
            2,
          ),
          rowsJson: JSON.stringify(prepared.payload, null, 2),
          codeUsagesJson: JSON.stringify(
            codeUsagesByTable.get(ref.table_name) ?? [],
            null,
            2,
          ),
        }),
        model: AI_CONFIG.chatModel,
      });

      let record = controlTableAnalysisRecordSchema.parse({
        ...call.data,
        source_key: def.source_key,
        table_name: ref.table_name,
        selection_reason: ref.selection_reasons.join("; "),
        model: call.model,
        prompt_version: CONTROL_TABLE_ANALYSIS_PROMPT_VERSION,
        content_hash,
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        estimated_cost: call.estimated_cost,
        duration_ms: call.duration_ms,
      });

      const hardened = hardenTableAnalysisEvidence({
        record,
        definition: {
          source_key: def.source_key,
          description: def.description,
          table_name: ref.table_name,
        },
        rows: tableRows,
        classification: classif.get(ref.table_name) as
          | { classification?: string }
          | undefined,
      });
      record = hardened.record;

      tableResults.set(def.source_key, record);
      analyzedTables += 1;
      sumIn += call.input_tokens;
      sumOut += call.output_tokens;
      sumCost += call.estimated_cost;
      sumDur += call.duration_ms;
      console.log(
        `OK table ${ref.table_name} conf=${record.confidence} tokens=${call.input_tokens}/${call.output_tokens}`,
      );
    } catch (error) {
      tableErrors += 1;
      console.error(
        `FAIL table ${ref.table_name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // --- Interpretations for all direct resolutions ---
  let analyzedLinks = 0;
  let skippedLinks = 0;
  let linkErrors = 0;
  // Dedupe by access_id — keep at most one record per technical access
  const interpByAccess = new Map<
    string,
    CodeTableInterpretationRecord & {
      access_id?: string;
      business_rule_id?: string;
    }
  >(existingInterpsByAccess);
  const unchangedPilotKeys = new Set<string>();

  const resolvedTargets = classified.filter((c) => c.kind === "resolved");

  for (const t of resolvedTargets) {
    const row = t.resolved!;
    const unit = unitsByKey.get(t.access.code_source_key);
    if (!unit) {
      linkErrors += 1;
      continue;
    }
    const source_code = String(unit.source_code ?? "");
    const window = extractAccessEvidenceWindow({
      sourceCode: source_code,
      evidenceCode: t.access.evidence_code,
      occurrenceIndex: t.occurrence_index,
      afterRadius: 16,
    });
    const lineStart = window[0]?.line ?? t.access.line_start ?? 0;
    const access_id = makeAccessId({
      code_source_key: t.access.code_source_key,
      table_name: t.access.table_name,
      evidence_code: t.access.evidence_code,
      occurrence_index: t.occurrence_index,
      line_start: lineStart,
    });
    const resolved_key = serializeCanonicalPrimaryKey(
      defs.get(t.access.table_name)?.key_fields ?? Object.keys(row.primary_key),
      row.primary_key,
    );
    const business_rule_id = makeBusinessRuleId({
      code_source_key: t.access.code_source_key,
      table_name: t.access.table_name,
      resolved_key,
      effect_fingerprint: effectFingerprintFromWindow(window),
    });

    // Stable source_key tied to access_id (prevents duplicate access records)
    const source_key = `${t.access.code_source_key}||${row.source_key}||${access_id}`;

    const content_hash = sha256Stable({
      access_id,
      business_rule_id,
      window: window.map((l) => formatLine(l)),
      row_hash: row.row_hash,
      prompt: CODE_TABLE_INTERPRETATION_PROMPT_VERSION,
      harden: "v1",
    });

    const prior =
      interpByAccess.get(access_id) ?? existingInterpsByKey.get(source_key);
    if (
      prior &&
      prior.content_hash === content_hash &&
      prior.prompt_version === CODE_TABLE_INTERPRETATION_PROMPT_VERSION &&
      prior.access_id === access_id
    ) {
      skippedLinks += 1;
      const migrated =
        prior.source_key === source_key
          ? prior
          : { ...prior, source_key };
      unchangedPilotKeys.add(migrated.source_key);
      interpByAccess.set(access_id, migrated);
      console.log(
        `SKIP link ${t.access.method_name} ${resolved_key} occ=${t.occurrence_index}`,
      );
      continue;
    }

    const detCode = deterministicCodeEvidence(window);
    const detTable = deterministicTableEvidence(row);
    const snippet = buildNumberedSnippet(window);
    const def = defs.get(t.access.table_name);
    const unitAnalysis = unitAnalyses.get(t.access.code_source_key);
    const tableAnalysis = [...tableResults.values()].find(
      (x) => x.table_name === t.access.table_name,
    );

    try {
      console.log(
        `ANALYZE link ${t.access.method_name} → ${resolved_key} occ=${t.occurrence_index} L${window[0]?.line}-L${window.at(-1)?.line}`,
      );
      const call = await generateStructuredWithUsage({
        schema: codeTableInterpretationModelSchema,
        schemaName: "code_table_interpretation_v1",
        system: buildCodeTableInterpretationSystemPrompt(),
        user: buildCodeTableInterpretationUserPrompt({
          className: String(unit.object_name ?? ""),
          methodName: t.access.method_name,
          tableName: t.access.table_name,
          codeSnippet: snippet,
          whereConditionsJson: JSON.stringify(t.access.where, null, 2),
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

      const inferences = [...call.data.inferences];
      if (
        call.data.business_rule_inferred &&
        !inferences.some((i) => i.text === call.data.business_rule_inferred)
      ) {
        inferences.push({
          text: call.data.business_rule_inferred,
          evidence: detCode.slice(0, 4),
        });
      }

      const usageFromModel = call.data.code_usage_after_read.filter((u) =>
        window.some(
          (l) =>
            l.text.includes(u.replace(/^L\d+\|/, "").slice(0, 24)) ||
            u.includes(l.text.trim().slice(0, 24)),
        ),
      );
      const usageFallback = window
        .filter((l) => /IF |ELSE|UPDATE|EQ |CS |ME->|L_STAT/i.test(l.text))
        .map((l) => formatLine(l));

      const record = codeTableInterpretationRecordSchema.parse({
        matched_conditions: (t.access.where ?? []).map((w) =>
          JSON.stringify(w),
        ),
        code_usage_after_read:
          usageFromModel.length > 0 ? usageFromModel : usageFallback,
        technical_interpretation: call.data.technical_interpretation,
        business_rule_inferred: call.data.business_rule_inferred,
        facts: call.data.facts,
        inferences,
        evidence_from_code: detCode,
        evidence_from_table: detTable,
        confidence: call.data.confidence,
        unresolved_points: call.data.unresolved_points,
        source_key,
        code_source_key: t.access.code_source_key,
        class_name: String(unit.object_name ?? ""),
        method_name: t.access.method_name,
        table_name: t.access.table_name,
        table_row_source_key: row.source_key,
        resolved_key,
        resolved_values: { ...row.values },
        access_id,
        business_rule_id,
        model: call.model,
        prompt_version: CODE_TABLE_INTERPRETATION_PROMPT_VERSION,
        content_hash,
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        estimated_cost: call.estimated_cost,
        duration_ms: call.duration_ms,
      });

      const codeCheck = countExactCodeEvidence(
        source_code,
        record.evidence_from_code,
      );
      if (codeCheck.bad.length > 0) {
        fail(
          `Ungültige Code-Evidence (${t.access.method_name}): ${codeCheck.bad[0]}`,
        );
      }

      deviations.push(
        ...validateHardenedInterpretation({
          record,
          sourceCode: source_code,
          tableRow: row,
          expectedResolvedKey: resolved_key,
        }),
      );

      interpByAccess.set(access_id, record);
      analyzedLinks += 1;
      sumIn += call.input_tokens;
      sumOut += call.output_tokens;
      sumCost += call.estimated_cost;
      sumDur += call.duration_ms;
      console.log(
        `OK link ${t.access.method_name} access=${access_id} conf=${record.confidence}`,
      );
    } catch (error) {
      linkErrors += 1;
      console.error(
        `FAIL link ${t.access.method_name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Persist analyses (keep non-code-referenced pilot tables too)
  const tableOut = [...tableResults.values()].sort((a, b) =>
    a.table_name.localeCompare(b.table_name),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "control-tables/table_analyses.jsonl",
    `${tableOut.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );

  // Only keep interpretations for current resolved access_ids (+ drop orphans)
  const currentAccessIds = new Set(
    resolvedTargets.map((t) => {
      const row = t.resolved!;
      const unit = unitsByKey.get(t.access.code_source_key);
      const source_code = String(unit?.source_code ?? "");
      const window = extractAccessEvidenceWindow({
        sourceCode: source_code,
        evidenceCode: t.access.evidence_code,
        occurrenceIndex: t.occurrence_index,
        afterRadius: 16,
      });
      return makeAccessId({
        code_source_key: t.access.code_source_key,
        table_name: t.access.table_name,
        evidence_code: t.access.evidence_code,
        occurrence_index: t.occurrence_index,
        line_start: window[0]?.line ?? t.access.line_start ?? 0,
      });
    }),
  );
  const interpOut = [...interpByAccess.values()].filter(
    (r) => r.access_id && currentAccessIds.has(r.access_id),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "relations/code_table_interpretations.jsonl",
    `${interpOut.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );

  // --- Quality ---
  const accessIds = interpOut.map((r) => r.access_id ?? "");
  const seenAccess = new Set<string>();
  const dupAccess: string[] = [];
  for (const id of accessIds) {
    if (!id) continue;
    if (seenAccess.has(id)) dupAccess.push(id);
    else seenAccess.add(id);
  }
  let exactCode = 0;
  let totalCode = 0;
  let exactTable = 0;
  let totalTable = 0;
  for (const r of interpOut) {
    const unit = unitsByKey.get(r.code_source_key);
    const row = rowsByKey.get(r.table_row_source_key);
    if (!unit || !row) continue;
    const c = countExactCodeEvidence(
      String(unit.source_code ?? ""),
      r.evidence_from_code,
    );
    const t = countExactTableEvidence(row, r.evidence_from_table);
    exactCode += c.exact;
    totalCode += c.total;
    exactTable += t.exact;
    totalTable += t.total;
    for (const bad of c.bad) {
      deviations.push({
        at: new Date().toISOString(),
        scope: "code_table_interpretation",
        source_key: r.source_key,
        code: "CODE_EVIDENCE_NOT_EXACT",
        message: bad.slice(0, 160),
      });
    }
  }

  const bruleGroups = new Map<string, string[]>();
  for (const r of interpOut) {
    const id = (r as { business_rule_id?: string }).business_rule_id;
    if (!id) continue;
    const list = bruleGroups.get(id) ?? [];
    list.push(`${r.method_name}:${(r as { access_id?: string }).access_id}`);
    bruleGroups.set(id, list);
  }

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

  const topRules = interpOut
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .reduce<
      Array<{
        business_rule_id: string;
        method: string;
        table: string;
        key: string;
        rule: string;
        confidence: number;
        access_count: number;
      }>
    >((acc, r) => {
      const id = (r as { business_rule_id?: string }).business_rule_id ?? "";
      if (acc.some((x) => x.business_rule_id === id)) return acc;
      acc.push({
        business_rule_id: id,
        method: r.method_name,
        table: r.table_name,
        key: r.resolved_key,
        rule: r.business_rule_inferred,
        confidence: r.confidence,
        access_count: bruleGroups.get(id)?.length ?? 1,
      });
      return acc;
    }, [])
    .slice(0, 10);

  const interestingUnresolved = [
    ...dynamicRecords.slice(0, 3).map((d) => ({
      kind: "dynamic_access",
      method: d.method_name,
      table: d.table_name,
      reason: d.unresolved_reason,
      variables: d.variable_source,
    })),
    ...interpOut
      .flatMap((r) =>
        r.unresolved_points.map((u) => ({
          kind: "interpretation_unresolved",
          method: r.method_name,
          table: r.table_name,
          reason: u,
        })),
      )
      .slice(0, 5),
  ].slice(0, 5);

  const report = {
    at: new Date().toISOString(),
    model: AI_CONFIG.chatModel,
    code_referenzierte_tabellen: inventory.length,
    tabellen_analysiert: analyzedTables,
    tabellen_uebersprungen: skippedTables,
    direkte_verknuepfungen_analysiert: analyzedLinks,
    direkte_verknuepfungen_uebersprungen: skippedLinks,
    geschaeftsregeln_erzeugt: bruleGroups.size,
    kandidatenaufloesungen: candidateRecords.length,
    dynamische_zugriffe: dynamicRecords.length,
    unresolved_faelle: dynamicRecords.length + candidateRecords.length,
    fehler: tableErrors + linkErrors,
    input_tokens: sumIn,
    output_tokens: sumOut,
    gesamtkosten_usd: Number(sumCost.toFixed(6)),
    laufzeit_ms: sumDur,
    qualitaet: {
      exact_code_evidence: `${exactCode}/${totalCode}`,
      exact_table_evidence: `${exactTable}/${totalTable}`,
      duplicate_access_ids: dupAccess,
      unveraenderte_pilot_records: unchangedPilotKeys.size,
      abweichungen: parsedDevs.length,
    },
    inventory,
    sampling_notes: samplingNotes,
    top_geschaeftsregeln: topRules,
    interessanteste_unresolved: interestingUnresolved,
    gruppierbare_geschaeftsregeln: [...bruleGroups.entries()].map(
      ([id, members]) => ({ business_rule_id: id, members }),
    ),
    geaenderte_dateien: [
      "scripts/scale-code-referenced-control-tables.ts",
      "src/lib/analysis/codeTableLinkExtract.ts",
      "package.json",
      "P01/logs/control-tables/code_referenced_tables.json",
      "P01/analyses/control-tables/table_analyses.jsonl",
      "P01/analyses/relations/code_table_interpretations.jsonl",
      "P01/analyses/relations/code_table_resolution_candidates.jsonl",
      "P01/analyses/relations/dynamic_table_accesses.jsonl",
      "P01/logs/control-tables/scale_code_referenced_report.json",
      "P01/logs/control-tables/analysis_deviations.jsonl",
    ],
  };

  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "control-tables/scale_code_referenced_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log("\n=== SCALE BERICHT ===");
  console.log(`code-referenzierte Tabellen: ${inventory.length}`);
  console.log(`davon analysiert: ${analyzedTables}`);
  console.log(`davon übersprungen: ${skippedTables}`);
  console.log(`direkte Verknüpfungen analysiert: ${analyzedLinks}`);
  console.log(`direkte Verknüpfungen übersprungen: ${skippedLinks}`);
  console.log(`Geschäftsregeln: ${bruleGroups.size}`);
  console.log(`Kandidaten: ${candidateRecords.length}`);
  console.log(`dynamische Zugriffe: ${dynamicRecords.length}`);
  console.log(`Fehler: ${tableErrors + linkErrors}`);
  console.log(`tokens in/out: ${sumIn}/${sumOut}`);
  console.log(`Kosten USD: ${report.gesamtkosten_usd}`);
  console.log(`Laufzeit ms: ${sumDur}`);
  console.log(
    `Evidence code/table: ${exactCode}/${totalCode} | ${exactTable}/${totalTable}`,
  );
  console.log(`dup access_ids: ${dupAccess.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
