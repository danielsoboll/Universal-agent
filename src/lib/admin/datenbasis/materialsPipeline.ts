/**
 * Materials (Materialstammdaten) pipeline steps B–F.
 * RAW is never modified. No OpenAI / embeddings / RAG analyze.
 *
 * Evidence (P01, 2026-08-04): multi-file set per table
 *   MASTER_STRUCTURE + MASTER_CONTENT for MARA|MARC|MARD|MVKE|MARM
 */

import { createWriteStream, existsSync, readFileSync, statSync } from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { finished } from "stream/promises";
import {
  materialsValidationOk,
  streamCanonicalizeMaterialsFile,
  streamCanonicalizeMaterialsFileWriting,
  type MaterialsCanonicalStats,
} from "@/lib/ingest/materialsCanonical";
import {
  appendLogLine,
  ensureWritableDir,
  listRawEntries,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveRawPath, resolveWritablePath } from "@/lib/localData/paths";
import { getExportTypeConfig } from "@/lib/admin/datenbasis/exportTypeConfig";
import type { DetectedRawFile } from "@/lib/admin/datenbasis/classesPipeline";
import type { DatenbasisStepResult } from "@/lib/admin/datenbasis/types";

const RAW_PARTS = ["master-data", "materials"] as const;
const CANONICAL_REL = "master-data/materials";
const LOG_PARTS = ["datenbasis", "materials"] as const;

/** Sentinel stored in manifest.selected_raw_file for the multi-table set. */
export const MATERIALS_SET_TOKEN = "__MATERIALS_SET__";

/** Tables observed in real RAW headers (table_name). */
export const MATERIALS_TABLES = [
  "MARA",
  "MARC",
  "MARD",
  "MVKE",
  "MARM",
] as const;
export type MaterialsTableName = (typeof MATERIALS_TABLES)[number];

export type MaterialsFileKind = "structure" | "content";

export type MappedMaterialsFile = DetectedRawFile & {
  table_name: MaterialsTableName | string;
  kind: MaterialsFileKind;
  profile: string | null;
  client: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function emptyStats(): MaterialsCanonicalStats {
  return {
    lines_total: 0,
    blank_lines: 0,
    valid: 0,
    invalid: 0,
    headers: 0,
    body_records: 0,
    duplicates: 0,
    key_collisions: 0,
    record_types: {},
  };
}

function mergeStats(
  a: MaterialsCanonicalStats,
  b: MaterialsCanonicalStats,
): MaterialsCanonicalStats {
  const record_types: Record<string, number> = { ...a.record_types };
  for (const [k, v] of Object.entries(b.record_types)) {
    record_types[k] = (record_types[k] ?? 0) + v;
  }
  return {
    lines_total: a.lines_total + b.lines_total,
    blank_lines: a.blank_lines + b.blank_lines,
    valid: a.valid + b.valid,
    invalid: a.invalid + b.invalid,
    headers: a.headers + b.headers,
    body_records: a.body_records + b.body_records,
    duplicates: a.duplicates + b.duplicates,
    key_collisions: a.key_collisions + b.key_collisions,
    record_types,
  };
}

async function readJsonlHeader(
  absolutePath: string,
): Promise<Record<string, unknown> | null> {
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          return obj as Record<string, unknown>;
        }
        return null;
      } catch {
        return null;
      }
    }
  } finally {
    rl.close();
  }
  return null;
}

function kindFromExportType(
  exportType: string | null,
): MaterialsFileKind | null {
  if (exportType === "MASTER_STRUCTURE") return "structure";
  if (exportType === "MASTER_CONTENT") return "content";
  return null;
}

function validateMaterialsHeader(header: Record<string, unknown> | null): {
  ok: boolean;
  errors: string[];
  export_type: string | null;
  system_id: string | null;
  schema_version: string | null;
  table_name: string | null;
  profile: string | null;
  client: string | null;
  kind: MaterialsFileKind | null;
} {
  const cfg = getExportTypeConfig("materials")!;
  const errors: string[] = [];
  if (!header) {
    return {
      ok: false,
      errors: ["Keine gültige Header-Zeile"],
      export_type: null,
      system_id: null,
      schema_version: null,
      table_name: null,
      profile: null,
      client: null,
      kind: null,
    };
  }

  const rules = cfg.headerRules ?? {};
  for (const [field, rule] of Object.entries(rules)) {
    const val = header[field];
    const asStr = typeof val === "string" ? val.trim() : "";
    if (rule.required && !asStr) {
      errors.push(`${field} fehlt oder ist leer`);
      continue;
    }
    if (rule.exact != null && asStr !== rule.exact) {
      errors.push(`${field}: erwartet "${rule.exact}", erhalten "${asStr}"`);
    }
  }

  const export_type =
    typeof header.export_type === "string" ? header.export_type.trim() : null;
  const kind = kindFromExportType(export_type);
  if (export_type && !kind) {
    errors.push(
      `export_type: erwartet MASTER_CONTENT|MASTER_STRUCTURE, erhalten "${export_type}"`,
    );
  }

  const table_name =
    typeof header.table_name === "string" ? header.table_name.trim() : null;
  if (!table_name) {
    errors.push("table_name fehlt oder ist leer");
  } else if (
    !(MATERIALS_TABLES as readonly string[]).includes(table_name)
  ) {
    errors.push(
      `table_name: unerwartete Tabelle "${table_name}" (erwartet ${MATERIALS_TABLES.join("|")})`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    export_type,
    system_id:
      typeof header.system_id === "string" ? header.system_id.trim() : null,
    schema_version:
      typeof header.schema_version === "string"
        ? header.schema_version.trim()
        : null,
    table_name,
    profile: typeof header.profile === "string" ? header.profile.trim() : null,
    client: typeof header.client === "string" ? header.client.trim() : null,
    kind,
  };
}

function slotKey(table: string, kind: MaterialsFileKind): string {
  return `${table}:${kind}`;
}

function expectedSlots(): { table: MaterialsTableName; kind: MaterialsFileKind }[] {
  const out: { table: MaterialsTableName; kind: MaterialsFileKind }[] = [];
  for (const table of MATERIALS_TABLES) {
    out.push({ table, kind: "structure" });
    out.push({ table, kind: "content" });
  }
  return out;
}

function assessCompleteness(mapped: MappedMaterialsFile[]): {
  complete: boolean;
  present: string[];
  missing: string[];
  duplicates: string[];
  systemIds: string[];
} {
  const bySlot = new Map<string, MappedMaterialsFile[]>();
  for (const f of mapped) {
    const k = slotKey(f.table_name, f.kind);
    const list = bySlot.get(k) ?? [];
    list.push(f);
    bySlot.set(k, list);
  }
  const present: string[] = [];
  const missing: string[] = [];
  const duplicates: string[] = [];
  for (const { table, kind } of expectedSlots()) {
    const k = slotKey(table, kind);
    const list = bySlot.get(k) ?? [];
    if (list.length === 0) missing.push(k);
    else if (list.length === 1) present.push(k);
    else {
      present.push(k);
      duplicates.push(`${k} (${list.length} Dateien)`);
    }
  }
  const systemIds = [
    ...new Set(mapped.map((m) => m.system_id).filter(Boolean) as string[]),
  ];
  return {
    complete: missing.length === 0 && duplicates.length === 0,
    present,
    missing,
    duplicates,
    systemIds,
  };
}

function setSelectedStub(mapped: MappedMaterialsFile[]): DetectedRawFile {
  const bytes = mapped.reduce((s, f) => s + f.bytes, 0);
  const first = mapped[0]!;
  return {
    relativePath: [...RAW_PARTS, MATERIALS_SET_TOKEN].join("/"),
    fileName: MATERIALS_SET_TOKEN,
    bytes,
    headerOk: mapped.every((m) => m.headerOk),
    headerErrors: [],
    export_type: "MASTER_CONTENT|MASTER_STRUCTURE",
    system_id: first.system_id,
    schema_version: first.schema_version,
  };
}

async function listMappedMaterialsFiles(
  projectKey: string,
): Promise<{
  ok: boolean;
  files: MappedMaterialsFile[];
  errors: string[];
  dirMissing: boolean;
}> {
  const dirAbs = resolveRawPath(projectKey, ...RAW_PARTS);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    return { ok: false, files: [], errors: [`${RAW_PARTS.join("/")} existiert nicht`], dirMissing: true };
  }

  let entries: string[];
  try {
    entries = listRawEntries(projectKey, ...RAW_PARTS).filter((n) => {
      if (n.startsWith(".") || n === "_quarantine") return false;
      if (!n.toLowerCase().endsWith(".jsonl")) return false;
      try {
        const abs = resolveRawPath(projectKey, ...RAW_PARTS, n);
        return existsSync(abs) && statSync(abs).isFile();
      } catch {
        return false;
      }
    });
  } catch (e) {
    return {
      ok: false,
      files: [],
      errors: [e instanceof Error ? e.message : String(e)],
      dirMissing: false,
    };
  }

  const files: MappedMaterialsFile[] = [];
  for (const fileName of entries) {
    const absolutePath = resolveRawPath(projectKey, ...RAW_PARTS, fileName);
    const bytes = statSync(absolutePath).size;
    const header = await readJsonlHeader(absolutePath);
    const hv = validateMaterialsHeader(header);
    files.push({
      relativePath: [...RAW_PARTS, fileName].join("/"),
      fileName,
      bytes,
      headerOk: hv.ok,
      headerErrors: hv.errors,
      export_type: hv.export_type,
      system_id: hv.system_id,
      schema_version: hv.schema_version,
      table_name: hv.table_name ?? "?",
      kind: hv.kind ?? "content",
      profile: hv.profile,
      client: hv.client,
    });
  }

  return { ok: true, files, errors: [], dirMissing: false };
}

/** Step B: detect RAW under raw/master-data/materials + header validation. */
export async function detectMaterialsRaw(
  projectKey: string,
  selectedFileName?: string | null,
): Promise<{
  ok: boolean;
  result: DatenbasisStepResult;
  selected: DetectedRawFile | null;
  files: DetectedRawFile[];
  mapped: MappedMaterialsFile[];
  completeness: ReturnType<typeof assessCompleteness> | null;
}> {
  const cfg = getExportTypeConfig("materials")!;
  const listed = await listMappedMaterialsFiles(projectKey);
  if (listed.dirMissing) {
    return {
      ok: false,
      selected: null,
      files: [],
      mapped: [],
      completeness: null,
      result: {
        summary: `Ordner fehlt: ${cfg.rawFolder}`,
        ok: false,
        errors: listed.errors,
      },
    };
  }
  if (!listed.ok) {
    return {
      ok: false,
      selected: null,
      files: [],
      mapped: [],
      completeness: null,
      result: {
        summary: "RAW-Ordner nicht lesbar",
        ok: false,
        errors: listed.errors,
      },
    };
  }

  const files = listed.files;
  if (files.length === 0) {
    return {
      ok: false,
      selected: null,
      files: [],
      mapped: [],
      completeness: null,
      result: {
        summary: "Keine .jsonl unter raw/master-data/materials",
        ok: false,
        errors: [
          "Bitte Materialstammdaten-Export unter raw/master-data/materials ablegen",
        ],
        hint: "Header: export_type=MASTER_CONTENT|MASTER_STRUCTURE, table_name=MARA|…",
      },
    };
  }

  const valid = files.filter((f) => f.headerOk);
  const completeness = assessCompleteness(valid);

  if (valid.length === 0) {
    return {
      ok: false,
      selected: null,
      files,
      mapped: files,
      completeness,
      result: {
        summary: "Keine Datei mit gültigem Materials-Header",
        ok: false,
        errors: files.flatMap((f) =>
          f.headerErrors.map((e) => `${f.fileName}: ${e}`),
        ),
        files: files.map((f) => ({
          relativePath: f.relativePath,
          fileName: f.fileName,
          bytes: f.bytes,
        })),
        technical: {
          mapping: files.map((f) => ({
            fileName: f.fileName,
            table_name: f.table_name,
            kind: f.kind,
            export_type: f.export_type,
            headerOk: f.headerOk,
            errors: f.headerErrors,
          })),
          completeness,
        },
      },
    };
  }

  // Explicit single-file selection still supported.
  if (
    selectedFileName &&
    selectedFileName !== MATERIALS_SET_TOKEN &&
    valid.some((f) => f.fileName === selectedFileName)
  ) {
    const selected = valid.find((f) => f.fileName === selectedFileName)!;
    return {
      ok: true,
      selected,
      files,
      mapped: files,
      completeness,
      result: {
        summary: `RAW erkannt (Einzeldatei): ${selected.fileName} → ${selected.table_name}/${selected.kind}`,
        ok: true,
        files: files.map((f) => ({
          relativePath: f.relativePath,
          fileName: f.fileName,
          bytes: f.bytes,
          selected: f.fileName === selected.fileName,
        })),
        counts: {
          total: files.length,
          valid_headers: valid.length,
          bytes: selected.bytes,
          complete: completeness.complete ? 1 : 0,
        },
        technical: {
          mode: "single",
          table_name: selected.table_name,
          kind: selected.kind,
          completeness,
          mapping: valid.map((f) => ({
            fileName: f.fileName,
            table_name: f.table_name,
            kind: f.kind,
            export_type: f.export_type,
            bytes: f.bytes,
          })),
        },
      },
    };
  }

  // Default: treat all valid files as the materials set (multi-table).
  const selected = setSelectedStub(valid);
  const warnings: string[] = [];
  if (!completeness.complete) {
    warnings.push(
      `Set unvollständig — fehlt: ${completeness.missing.join(", ") || "—"}`,
    );
  }
  if (completeness.duplicates.length) {
    warnings.push(`Duplikat-Slots: ${completeness.duplicates.join(", ")}`);
  }
  if (completeness.systemIds.length > 1) {
    warnings.push(`Mehrere system_id: ${completeness.systemIds.join(", ")}`);
  }

  return {
    ok: true,
    selected,
    files,
    mapped: files,
    completeness,
    result: {
      summary: completeness.complete
        ? `RAW-Set vollständig: ${valid.length} Dateien (MARA/MARC/MARD/MVKE/MARM × STRUCTURE+CONTENT), system_id=${selected.system_id}`
        : `RAW-Set erkannt (${valid.length} gültig), unvollständig — fehlt ${completeness.missing.length} Slot(s)`,
      ok: true,
      files: files.map((f) => ({
        relativePath: f.relativePath,
        fileName: f.fileName,
        bytes: f.bytes,
        selected: f.headerOk,
      })),
      counts: {
        total: files.length,
        valid_headers: valid.length,
        bytes: selected.bytes,
        slots_present: completeness.present.length,
        slots_expected: expectedSlots().length,
        complete: completeness.complete ? 1 : 0,
      },
      errors: warnings.length ? warnings : undefined,
      technical: {
        mode: "set",
        set_token: MATERIALS_SET_TOKEN,
        completeness,
        certainty: cfg.certainty,
        mapping: valid.map((f) => ({
          fileName: f.fileName,
          table_name: f.table_name,
          kind: f.kind,
          export_type: f.export_type,
          system_id: f.system_id,
          schema_version: f.schema_version,
          profile: f.profile,
          bytes: f.bytes,
        })),
      },
    },
  };
}

function filesToProcess(
  mapped: MappedMaterialsFile[],
  fileName: string,
): MappedMaterialsFile[] {
  const valid = mapped.filter((f) => f.headerOk);
  if (fileName === MATERIALS_SET_TOKEN || !fileName) {
    return valid;
  }
  const one = valid.find((f) => f.fileName === fileName);
  return one ? [one] : valid;
}

/** Step C: streaming JSONL validate (no OpenAI). */
export async function validateMaterialsJsonl(
  projectKey: string,
  fileName: string,
): Promise<{ ok: boolean; result: DatenbasisStepResult }> {
  const listed = await listMappedMaterialsFiles(projectKey);
  if (!listed.ok || listed.files.length === 0) {
    return {
      ok: false,
      result: {
        summary: "Keine Materials-RAW-Dateien",
        ok: false,
        errors: listed.errors.length
          ? listed.errors
          : ["RAW-Dateien nicht gefunden"],
      },
    };
  }

  const targets = filesToProcess(listed.files, fileName);
  if (targets.length === 0) {
    return {
      ok: false,
      result: {
        summary: `Keine gültigen Dateien für Validierung (${fileName})`,
        ok: false,
        errors: ["Auswahl leer oder Header ungültig"],
      },
    };
  }

  let stats = emptyStats();
  const perFile: Array<Record<string, unknown>> = [];
  const issueSamples: string[] = [];
  let allOk = true;

  for (const f of targets) {
    const absolutePath = resolveRawPath(projectKey, ...RAW_PARTS, f.fileName);
    const canonical = await streamCanonicalizeMaterialsFile({
      absolutePath,
      sourceFileName: f.fileName,
      sourceBytes: f.bytes,
      omitRecords: true,
    });
    const ok = materialsValidationOk(canonical);
    if (!ok) allOk = false;
    stats = mergeStats(stats, canonical.stats);
    perFile.push({
      fileName: f.fileName,
      table_name: f.table_name,
      kind: f.kind,
      export_type: f.export_type,
      ok,
      stats: canonical.stats,
      observed_table_name: canonical.observed_table_name,
    });
    for (const i of canonical.issues.slice(0, 5)) {
      issueSamples.push(`${f.fileName} Z.${i.lineNumber}: ${i.error}`);
    }
  }

  const completeness = assessCompleteness(targets);
  const id = runId();
  ensureWritableDir(projectKey, "logs", ...LOG_PARTS);
  const reportPath = `datenbasis/materials/validate-${id}.json`;
  const report = {
    ok: allOk,
    started_at: nowIso(),
    mode: targets.length > 1 ? "set" : "single",
    completeness,
    per_file: perFile,
    stats,
    issues_sample: issueSamples.slice(0, 50),
    notes: [
      "Streaming-Validierung (readline)",
      "Kein OpenAI",
      "Mapping aus Header table_name + export_type (MASTER_*)",
    ],
  };
  writeGeneratedText(
    projectKey,
    "logs",
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );

  return {
    ok: allOk,
    result: {
      summary: allOk
        ? `Validierung OK: ${targets.length} Datei(en), ${stats.body_records} Body-Zeilen`
        : `Validierung fehlgeschlagen: invalid=${stats.invalid}, collisions=${stats.key_collisions}`,
      ok: allOk,
      report_path: `logs/${reportPath}`,
      counts: {
        files: targets.length,
        lines_total: stats.lines_total,
        valid: stats.valid,
        invalid: stats.invalid,
        headers: stats.headers,
        body_records: stats.body_records,
        duplicates: stats.duplicates,
        key_collisions: stats.key_collisions,
        complete: completeness.complete ? 1 : 0,
      },
      errors: allOk ? undefined : issueSamples.slice(0, 10),
      technical: {
        completeness,
        per_file: perFile,
        record_types: stats.record_types,
      },
    },
  };
}

/** Step D: convert to canonical/master-data/materials (RAW untouched). */
export async function convertMaterials(
  projectKey: string,
  fileName: string,
): Promise<{ ok: boolean; result: DatenbasisStepResult }> {
  const listed = await listMappedMaterialsFiles(projectKey);
  if (!listed.ok || listed.files.length === 0) {
    return {
      ok: false,
      result: {
        summary: "Keine Materials-RAW-Dateien",
        ok: false,
        errors: listed.errors.length
          ? listed.errors
          : ["RAW-Dateien nicht gefunden"],
      },
    };
  }

  const targets = filesToProcess(listed.files, fileName);
  if (targets.length === 0) {
    return {
      ok: false,
      result: {
        summary: `Keine Dateien für Konvertierung (${fileName})`,
        ok: false,
        errors: ["Auswahl leer"],
      },
    };
  }

  const startedAt = nowIso();
  ensureWritableDir(projectKey, "canonical", "master-data", "materials");
  ensureWritableDir(projectKey, "logs", ...LOG_PARTS);

  const recordsAbs = resolveWritablePath(
    projectKey,
    "canonical",
    `${CANONICAL_REL}/records.jsonl`,
  );
  // Truncate combined content records file.
  writeGeneratedText(projectKey, "canonical", `${CANONICAL_REL}/records.jsonl`, "");

  let stats = emptyStats();
  const perFile: Array<Record<string, unknown>> = [];
  const allIssues: Array<{ file: string; lineNumber: number; error: string }> =
    [];
  const headers: Record<string, unknown>[] = [];
  const outputs: string[] = [
    `${CANONICAL_REL}/header.json`,
    `${CANONICAL_REL}/records.jsonl`,
    `${CANONICAL_REL}/ingest_report.json`,
  ];

  const recordsStream = createWriteStream(recordsAbs, { flags: "a" });

  try {
    for (const f of targets) {
      const absolutePath = resolveRawPath(projectKey, ...RAW_PARTS, f.fileName);
      ensureWritableDir(
        projectKey,
        "canonical",
        "master-data",
        "materials",
        f.table_name,
      );
      const perRel = `${CANONICAL_REL}/${f.table_name}/${f.kind}.jsonl`;
      const perAbs = resolveWritablePath(projectKey, "canonical", perRel);
      writeGeneratedText(projectKey, "canonical", perRel, "");
      const perStream = createWriteStream(perAbs, { flags: "a" });

      const result = await streamCanonicalizeMaterialsFileWriting({
        absolutePath,
        sourceFileName: f.fileName,
        sourceBytes: f.bytes,
        writeLine: (line) => {
          perStream.write(`${line}\n`);
          if (f.kind === "content") {
            recordsStream.write(`${line}\n`);
          }
        },
      });
      perStream.end();
      await finished(perStream);

      stats = mergeStats(stats, result.stats);
      headers.push(...result.headers);
      outputs.push(perRel);
      perFile.push({
        fileName: f.fileName,
        table_name: f.table_name,
        kind: f.kind,
        export_type: f.export_type,
        body_records: result.stats.body_records,
        invalid: result.stats.invalid,
        key_collisions: result.stats.key_collisions,
        duplicates: result.stats.duplicates,
        canonical: `canonical/${perRel}`,
      });
      for (const i of result.issues) {
        allIssues.push({
          file: f.fileName,
          lineNumber: i.lineNumber,
          error: i.error,
        });
      }
    }
  } finally {
    recordsStream.end();
    await finished(recordsStream);
  }

  const completeness = assessCompleteness(targets);
  const ok =
    stats.invalid === 0 &&
    stats.key_collisions === 0 &&
    stats.headers >= targets.length &&
    stats.body_records >= 1;

  const headerDoc = {
    source_set: targets.map((f) => ({
      relative: `raw/master-data/materials/${f.fileName}`,
      file_name: f.fileName,
      bytes: f.bytes,
      table_name: f.table_name,
      kind: f.kind,
      export_type: f.export_type,
      system_id: f.system_id,
      schema_version: f.schema_version,
      profile: f.profile,
    })),
    headers,
    completeness,
    observed_tables: MATERIALS_TABLES,
    certainty: "inferred_from_raw" as const,
    notes: [
      "Mapping aus Header: table_name + export_type MASTER_CONTENT|MASTER_STRUCTURE",
      "raw/ unverändert",
      "Kein OpenAI",
    ],
  };

  writeGeneratedText(
    projectKey,
    "canonical",
    `${CANONICAL_REL}/header.json`,
    `${JSON.stringify(headerDoc, null, 2)}\n`,
  );

  const id = runId();
  const convertReportPath = `datenbasis/materials/convert-${id}.json`;
  const ingestReport = {
    ok,
    started_at: startedAt,
    finished_at: nowIso(),
    project_key: projectKey,
    mode: targets.length > 1 ? "set" : "single",
    completeness,
    per_file: perFile,
    outputs: {
      header: `canonical/${CANONICAL_REL}/header.json`,
      records: `canonical/${CANONICAL_REL}/records.jsonl`,
      ingest_report: `canonical/${CANONICAL_REL}/ingest_report.json`,
      per_table: perFile.map((p) => p.canonical),
    },
    stats,
    issues: allIssues.slice(0, 100),
    notes: [
      "raw/ unverändert (nur gelesen)",
      "keine OpenAI-Aufrufe",
      "classes/indexes unberührt",
    ],
  };

  writeGeneratedText(
    projectKey,
    "canonical",
    `${CANONICAL_REL}/ingest_report.json`,
    `${JSON.stringify(ingestReport, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "logs",
    convertReportPath,
    `${JSON.stringify(ingestReport, null, 2)}\n`,
  );
  appendLogLine(
    projectKey,
    "datenbasis-materials.log",
    `[${ingestReport.finished_at}] convert materials files=${targets.length} ok=${ok} body=${stats.body_records}`,
  );

  const missing = outputs.filter(
    (rel) => !existsSync(resolveWritablePath(projectKey, "canonical", rel)),
  );
  const complete = ok && missing.length === 0;

  return {
    ok: complete,
    result: {
      summary: complete
        ? `Konvertierung OK: ${targets.length} Dateien, ${stats.body_records} Body-Zeilen → canonical/${CANONICAL_REL}/`
        : "Konvertierung unvollständig",
      ok: complete,
      report_path: `logs/${convertReportPath}`,
      counts: {
        files: targets.length,
        lines_total: stats.lines_total,
        valid: stats.valid,
        invalid: stats.invalid,
        headers: stats.headers,
        body_records: stats.body_records,
        duplicates: stats.duplicates,
        key_collisions: stats.key_collisions,
        complete: completeness.complete ? 1 : 0,
      },
      errors: missing.length
        ? missing.map((m) => `Fehlt: canonical/${m}`)
        : allIssues.slice(0, 5).map((i) => `${i.file}: ${i.error}`),
      technical: {
        canonical_paths: outputs.map((o) => `canonical/${o}`),
        per_file: perFile,
        completeness,
        record_types: stats.record_types,
      },
    },
  };
}

/** Step E: deterministic smoke questions from canonical (no OpenAI). */
export function buildMaterialsTestQuestions(
  projectKey: string,
): { ok: boolean; result: DatenbasisStepResult } {
  const reportPath = resolveWritablePath(
    projectKey,
    "canonical",
    `${CANONICAL_REL}/ingest_report.json`,
  );
  const recordsPath = resolveWritablePath(
    projectKey,
    "canonical",
    `${CANONICAL_REL}/records.jsonl`,
  );
  if (!existsSync(reportPath) || !existsSync(recordsPath)) {
    return {
      ok: false,
      result: {
        summary: "Canonical Materials fehlen — zuerst konvertieren",
        ok: false,
        errors: [
          `canonical/${CANONICAL_REL}/ingest_report.json oder records.jsonl fehlt`,
        ],
      },
    };
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    stats?: { body_records?: number; headers?: number };
    completeness?: { complete?: boolean };
    per_file?: Array<{ table_name?: string; kind?: string; body_records?: number }>;
  };
  const body = report.stats?.body_records ?? 0;
  const tables = new Set(
    (report.per_file ?? [])
      .filter((p) => p.kind === "content")
      .map((p) => p.table_name)
      .filter(Boolean),
  );

  let firstKey: string | null = null;
  for (const line of readFileSync(recordsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { _canonical_key?: string };
      if (typeof obj._canonical_key === "string") {
        firstKey = obj._canonical_key;
        break;
      }
    } catch {
      /* skip */
    }
  }

  const cases = [
    {
      question: `Wie viele Material-Content-Datensätze liegen in canonical/${CANONICAL_REL}/records.jsonl?`,
      ok: body > 0,
      detail: String(body),
    },
    {
      question: `Sind alle Tabellen MARA/MARC/MARD/MVKE/MARM im Set vertreten?`,
      ok: MATERIALS_TABLES.every((t) => tables.has(t)),
      detail: [...tables].sort().join(","),
    },
    {
      question: `Ist das Materials-RAW-Set vollständig (STRUCTURE+CONTENT je Tabelle)?`,
      ok: Boolean(report.completeness?.complete),
      detail: String(report.completeness?.complete ?? false),
    },
  ];

  return {
    ok: cases.every((c) => c.ok),
    result: {
      summary: `3 Testfragen aus Canonical (body=${body}, key=${firstKey ?? "—"})`,
      ok: cases.every((c) => c.ok),
      cases,
      technical: { first_canonical_key: firstKey, no_openai: true },
    },
  };
}

/**
 * Step F: intentionally skipped — no materials embeddings/index/RAG.
 * Does not call OpenAI. Marks step done so Freigabe möglich bleibt.
 */
export async function runMaterialsRagTestSkipped(): Promise<{
  ok: boolean;
  result: DatenbasisStepResult;
}> {
  return {
    ok: true,
    result: {
      summary:
        "RAG-Test übersprungen — kein Materials-Index/Embeddings (bewusst, kein OpenAI)",
      ok: true,
      technical: {
        skipped: true,
        reason: "no_materials_index",
        no_openai: true,
      },
    },
  };
}
