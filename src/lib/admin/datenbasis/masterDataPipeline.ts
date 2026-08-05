/**
 * Generic master-data pipeline (detect → validate → convert).
 * Domain-specific tables/keys/relations via MasterDataDomainConfig.
 * RAW never modified. No OpenAI / embeddings / index rebuild.
 */

import { createWriteStream, existsSync, readFileSync, statSync } from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { finished } from "stream/promises";
import {
  enrichMasterStructureRecord,
  masterDataValidationOk,
  streamCanonicalizeMasterDataFile,
  streamCanonicalizeMasterDataFileWriting,
  type MasterDataCanonicalRecord,
  type MasterDataCanonicalStats,
} from "@/lib/ingest/masterDataCanonical";
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
import type {
  MasterDataDomainConfig,
  MasterDataFileKind,
} from "@/lib/admin/datenbasis/masterDataDomain";

export type MappedMasterDataFile = DetectedRawFile & {
  table_name: string;
  kind: MasterDataFileKind;
  profile: string | null;
  client: string | null;
};

export type MasterDataPipeline = {
  domain: MasterDataDomainConfig;
  detectRaw: (
    projectKey: string,
    selectedFileName?: string | null,
  ) => Promise<{
    ok: boolean;
    result: DatenbasisStepResult;
    selected: DetectedRawFile | null;
    files: DetectedRawFile[];
    mapped: MappedMasterDataFile[];
    completeness: Completeness | null;
  }>;
  validateJsonl: (
    projectKey: string,
    fileName: string,
  ) => Promise<{ ok: boolean; result: DatenbasisStepResult }>;
  convert: (
    projectKey: string,
    fileName: string,
  ) => Promise<{ ok: boolean; result: DatenbasisStepResult }>;
  buildTestQuestions: (projectKey: string) => {
    ok: boolean;
    result: DatenbasisStepResult;
  };
  runRagTestSkipped: () => Promise<{
    ok: boolean;
    result: DatenbasisStepResult;
  }>;
};

export type Completeness = {
  complete: boolean;
  present: string[];
  missing: string[];
  duplicates: string[];
  unexpected_tables: string[];
  systemIds: string[];
  schemaVersions: string[];
  profiles: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function emptyStats(): MasterDataCanonicalStats {
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
  a: MasterDataCanonicalStats,
  b: MasterDataCanonicalStats,
): MasterDataCanonicalStats {
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
): MasterDataFileKind | null {
  if (exportType === "MASTER_STRUCTURE") return "structure";
  if (exportType === "MASTER_CONTENT") return "content";
  return null;
}

function slotKey(table: string, kind: MasterDataFileKind): string {
  return `${table}:${kind}`;
}

function expectedSlots(
  domain: MasterDataDomainConfig,
): { table: string; kind: MasterDataFileKind }[] {
  const out: { table: string; kind: MasterDataFileKind }[] = [];
  for (const table of domain.tables) {
    out.push({ table, kind: "structure" });
    out.push({ table, kind: "content" });
  }
  return out;
}

function assessCompleteness(
  domain: MasterDataDomainConfig,
  mapped: MappedMasterDataFile[],
): Completeness {
  const bySlot = new Map<string, MappedMasterDataFile[]>();
  const unexpected_tables: string[] = [];
  for (const f of mapped) {
    if (!(domain.tables as readonly string[]).includes(f.table_name)) {
      unexpected_tables.push(`${f.fileName}→${f.table_name}`);
    }
    const k = slotKey(f.table_name, f.kind);
    const list = bySlot.get(k) ?? [];
    list.push(f);
    bySlot.set(k, list);
  }
  const present: string[] = [];
  const missing: string[] = [];
  const duplicates: string[] = [];
  for (const { table, kind } of expectedSlots(domain)) {
    const k = slotKey(table, kind);
    const list = bySlot.get(k) ?? [];
    if (list.length === 0) missing.push(k);
    else if (list.length === 1) present.push(k);
    else {
      present.push(k);
      duplicates.push(`${k} (${list.length} Dateien)`);
    }
  }
  return {
    complete:
      missing.length === 0 &&
      duplicates.length === 0 &&
      unexpected_tables.length === 0,
    present,
    missing,
    duplicates,
    unexpected_tables,
    systemIds: [
      ...new Set(mapped.map((m) => m.system_id).filter(Boolean) as string[]),
    ],
    schemaVersions: [
      ...new Set(
        mapped.map((m) => m.schema_version).filter(Boolean) as string[],
      ),
    ],
    profiles: [
      ...new Set(mapped.map((m) => m.profile).filter(Boolean) as string[]),
    ],
  };
}

function validateDomainHeader(
  domain: MasterDataDomainConfig,
  header: Record<string, unknown> | null,
): {
  ok: boolean;
  errors: string[];
  export_type: string | null;
  system_id: string | null;
  schema_version: string | null;
  table_name: string | null;
  profile: string | null;
  client: string | null;
  kind: MasterDataFileKind | null;
} {
  const cfg = getExportTypeConfig(domain.exportTypeId)!;
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
  } else if (!(domain.tables as readonly string[]).includes(table_name)) {
    errors.push(
      `table_name: unerwartete Tabelle "${table_name}" (erwartet ${domain.tables.join("|")})`,
    );
  }

  const profile =
    typeof header.profile === "string" ? header.profile.trim() : null;
  if (
    domain.expectedProfile &&
    profile &&
    profile !== domain.expectedProfile
  ) {
    errors.push(
      `profile: erwartet "${domain.expectedProfile}", erhalten "${profile}"`,
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
    profile,
    client: typeof header.client === "string" ? header.client.trim() : null,
    kind,
  };
}

function setSelectedStub(
  domain: MasterDataDomainConfig,
  mapped: MappedMasterDataFile[],
): DetectedRawFile {
  const bytes = mapped.reduce((s, f) => s + f.bytes, 0);
  const first = mapped[0]!;
  return {
    relativePath: [...domain.rawParts, domain.setToken].join("/"),
    fileName: domain.setToken,
    bytes,
    headerOk: mapped.every((m) => m.headerOk),
    headerErrors: [],
    export_type: "MASTER_CONTENT|MASTER_STRUCTURE",
    system_id: first.system_id,
    schema_version: first.schema_version,
  };
}

async function listMappedFiles(
  domain: MasterDataDomainConfig,
  projectKey: string,
): Promise<{
  ok: boolean;
  files: MappedMasterDataFile[];
  errors: string[];
  dirMissing: boolean;
}> {
  const dirAbs = resolveRawPath(projectKey, ...domain.rawParts);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    return {
      ok: false,
      files: [],
      errors: [`${domain.rawParts.join("/")} existiert nicht`],
      dirMissing: true,
    };
  }

  let entries: string[];
  try {
    entries = listRawEntries(projectKey, ...domain.rawParts).filter((n) => {
      if (n.startsWith(".") || n === "_quarantine") return false;
      if (!n.toLowerCase().endsWith(".jsonl")) return false;
      try {
        const abs = resolveRawPath(projectKey, ...domain.rawParts, n);
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

  const files: MappedMasterDataFile[] = [];
  for (const fileName of entries) {
    const absolutePath = resolveRawPath(
      projectKey,
      ...domain.rawParts,
      fileName,
    );
    const bytes = statSync(absolutePath).size;
    const header = await readJsonlHeader(absolutePath);
    const hv = validateDomainHeader(domain, header);
    files.push({
      relativePath: [...domain.rawParts, fileName].join("/"),
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

function filesToProcess(
  domain: MasterDataDomainConfig,
  mapped: MappedMasterDataFile[],
  fileName: string,
): MappedMasterDataFile[] {
  const valid = mapped.filter((f) => f.headerOk);
  if (fileName === domain.setToken || !fileName) {
    return valid;
  }
  const one = valid.find((f) => f.fileName === fileName);
  return one ? [one] : valid;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

function compositeKey(
  values: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  const parts: string[] = [];
  for (const k of keys) {
    const v = asNonEmptyString(values[k]);
    if (!v) return null;
    parts.push(`${k}=${v}`);
  }
  return parts.join("|");
}

async function collectContentKeySet(
  absolutePath: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const set = new Set<string>();
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        const values =
          obj.values && typeof obj.values === "object" && !Array.isArray(obj.values)
            ? (obj.values as Record<string, unknown>)
            : obj;
        const ck = compositeKey(values, keys);
        if (ck) set.add(ck);
      } catch {
        /* skip */
      }
    }
  } finally {
    rl.close();
  }
  return set;
}

async function countJoinCoverage(
  childAbs: string,
  parentKeys: Set<string>,
  joinKeys: readonly string[],
): Promise<{ child_rows: number; matched: number; unmatched: number }> {
  let child_rows = 0;
  let matched = 0;
  let unmatched = 0;
  const rl = createInterface({
    input: createReadStream(childAbs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        const values =
          obj.values && typeof obj.values === "object" && !Array.isArray(obj.values)
            ? (obj.values as Record<string, unknown>)
            : obj;
        const ck = compositeKey(values, joinKeys);
        if (!ck) continue;
        child_rows += 1;
        if (parentKeys.has(ck)) matched += 1;
        else unmatched += 1;
      } catch {
        /* skip */
      }
    }
  } finally {
    rl.close();
  }
  return { child_rows, matched, unmatched };
}

function countZAndAppend(structureAbs: string): {
  z_fields: number;
  append_includes: number;
  linked_to_content: number;
  total_fields: number;
} {
  if (!existsSync(structureAbs)) {
    return {
      z_fields: 0,
      append_includes: 0,
      linked_to_content: 0,
      total_fields: 0,
    };
  }
  let z_fields = 0;
  let append_includes = 0;
  let linked_to_content = 0;
  let total_fields = 0;
  for (const line of readFileSync(structureAbs, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      total_fields += 1;
      if (obj._is_z_field === true) z_fields += 1;
      if (obj._is_append_include === true) append_includes += 1;
      if (obj._linked_to_content === true) linked_to_content += 1;
    } catch {
      /* skip */
    }
  }
  return { z_fields, append_includes, linked_to_content, total_fields };
}

export function createMasterDataPipeline(
  domain: MasterDataDomainConfig,
): MasterDataPipeline {
  const RAW_PARTS = domain.rawParts;
  const CANONICAL_REL = domain.canonicalRel;
  const LOG_PARTS = domain.logParts;
  const canonOpts = { contentKeyFields: domain.contentKeyFields };

  async function detectRaw(
    projectKey: string,
    selectedFileName?: string | null,
  ): Promise<{
    ok: boolean;
    result: DatenbasisStepResult;
    selected: DetectedRawFile | null;
    files: DetectedRawFile[];
    mapped: MappedMasterDataFile[];
    completeness: Completeness | null;
  }> {
    const cfg = getExportTypeConfig(domain.exportTypeId)!;
    const listed = await listMappedFiles(domain, projectKey);
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
          summary: `Keine .jsonl unter ${cfg.rawFolder}`,
          ok: false,
          errors: [
            `Bitte ${domain.label}-Export unter ${cfg.rawFolder} ablegen`,
          ],
          hint: `Header: export_type=MASTER_CONTENT|MASTER_STRUCTURE, table_name=${domain.tables.join("|")}`,
        },
      };
    }

    const valid = files.filter((f) => f.headerOk);
    const completeness = assessCompleteness(domain, valid);

    if (valid.length === 0) {
      return {
        ok: false,
        selected: null,
        files,
        mapped: files,
        completeness,
        result: {
          summary: `Keine Datei mit gültigem ${domain.label}-Header`,
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

    if (
      selectedFileName &&
      selectedFileName !== domain.setToken &&
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

    const selected = setSelectedStub(domain, valid);
    const warnings: string[] = [];
    if (!completeness.complete) {
      if (completeness.missing.length) {
        warnings.push(`Fehlt: ${completeness.missing.join(", ")}`);
      }
      if (completeness.duplicates.length) {
        warnings.push(`Duplikat-Slots: ${completeness.duplicates.join(", ")}`);
      }
      if (completeness.unexpected_tables.length) {
        warnings.push(
          `Unerwartete Tabellen: ${completeness.unexpected_tables.join(", ")}`,
        );
      }
    }
    if (completeness.systemIds.length > 1) {
      warnings.push(`Mehrere system_id: ${completeness.systemIds.join(", ")}`);
    }
    if (completeness.schemaVersions.length > 1) {
      warnings.push(
        `Mehrere schema_version: ${completeness.schemaVersions.join(", ")}`,
      );
    }

    return {
      ok: true,
      selected,
      files,
      mapped: files,
      completeness,
      result: {
        summary: completeness.complete
          ? `RAW-Set vollständig: ${valid.length} Dateien (${domain.tables.join("/")} × STRUCTURE+CONTENT), system_id=${selected.system_id}`
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
          slots_expected: expectedSlots(domain).length,
          complete: completeness.complete ? 1 : 0,
        },
        errors: warnings.length ? warnings : undefined,
        technical: {
          mode: "set",
          set_token: domain.setToken,
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

  async function validateJsonl(projectKey: string, fileName: string) {
    const listed = await listMappedFiles(domain, projectKey);
    if (!listed.ok || listed.files.length === 0) {
      return {
        ok: false,
        result: {
          summary: `Keine ${domain.label}-RAW-Dateien`,
          ok: false,
          errors: listed.errors.length
            ? listed.errors
            : ["RAW-Dateien nicht gefunden"],
        } satisfies DatenbasisStepResult,
      };
    }

    const targets = filesToProcess(domain, listed.files, fileName);
    if (targets.length === 0) {
      return {
        ok: false,
        result: {
          summary: `Keine gültigen Dateien für Validierung (${fileName})`,
          ok: false,
          errors: ["Auswahl leer oder Header ungültig"],
        } satisfies DatenbasisStepResult,
      };
    }

    let stats = emptyStats();
    const perFile: Array<Record<string, unknown>> = [];
    const issueSamples: string[] = [];
    let allOk = true;

    for (const f of targets) {
      const absolutePath = resolveRawPath(
        projectKey,
        ...RAW_PARTS,
        f.fileName,
      );
      const canonical = await streamCanonicalizeMasterDataFile({
        absolutePath,
        sourceFileName: f.fileName,
        sourceBytes: f.bytes,
        omitRecords: true,
        options: canonOpts,
      });
      const ok = masterDataValidationOk(canonical);
      if (!ok) allOk = false;
      stats = mergeStats(stats, canonical.stats);
      perFile.push({
        fileName: f.fileName,
        table_name: f.table_name,
        kind: f.kind,
        export_type: f.export_type,
        schema_version: f.schema_version,
        ok,
        stats: canonical.stats,
        observed_table_name: canonical.observed_table_name,
        observed_profile: canonical.observed_profile,
      });
      for (const i of canonical.issues.slice(0, 5)) {
        issueSamples.push(`${f.fileName} Z.${i.lineNumber}: ${i.error}`);
      }
    }

    const completeness = assessCompleteness(domain, targets);
    const id = runId();
    ensureWritableDir(projectKey, "logs", ...LOG_PARTS);
    const reportPath = `datenbasis/${domain.exportTypeId}/validate-${id}.json`;
    const report = {
      ok: allOk,
      started_at: nowIso(),
      mode: targets.length > 1 ? "set" : "single",
      domain: domain.exportTypeId,
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
      } satisfies DatenbasisStepResult,
    };
  }

  async function convert(projectKey: string, fileName: string) {
    const listed = await listMappedFiles(domain, projectKey);
    if (!listed.ok || listed.files.length === 0) {
      return {
        ok: false,
        result: {
          summary: `Keine ${domain.label}-RAW-Dateien`,
          ok: false,
          errors: listed.errors.length
            ? listed.errors
            : ["RAW-Dateien nicht gefunden"],
        } satisfies DatenbasisStepResult,
      };
    }

    const targets = filesToProcess(domain, listed.files, fileName);
    if (targets.length === 0) {
      return {
        ok: false,
        result: {
          summary: `Keine Dateien für Konvertierung (${fileName})`,
          ok: false,
          errors: ["Auswahl leer"],
        } satisfies DatenbasisStepResult,
      };
    }

    const startedAt = nowIso();
    const [mdRoot, mdLeaf] = domain.rawParts;
    ensureWritableDir(projectKey, "canonical", mdRoot!, mdLeaf!);
    ensureWritableDir(projectKey, "logs", ...LOG_PARTS);

    const recordsAbs = resolveWritablePath(
      projectKey,
      "canonical",
      `${CANONICAL_REL}/records.jsonl`,
    );
    writeGeneratedText(
      projectKey,
      "canonical",
      `${CANONICAL_REL}/records.jsonl`,
      "",
    );

    let stats = emptyStats();
    const perFile: Array<Record<string, unknown>> = [];
    const allIssues: Array<{ file: string; lineNumber: number; error: string }> =
      [];
    const headers: Record<string, unknown>[] = [];
    const outputs: string[] = [
      `${CANONICAL_REL}/header.json`,
      `${CANONICAL_REL}/records.jsonl`,
      `${CANONICAL_REL}/relations.jsonl`,
      `${CANONICAL_REL}/ingest_report.json`,
    ];

    const recordsStream = createWriteStream(recordsAbs, { flags: "a" });
    const contentPaths = new Map<string, string>();
    const structurePaths = new Map<string, string>();
    let zFieldTotal = 0;
    let appendIncludeTotal = 0;

    try {
      for (const f of targets) {
        const absolutePath = resolveRawPath(
          projectKey,
          ...RAW_PARTS,
          f.fileName,
        );
        ensureWritableDir(
          projectKey,
          "canonical",
          mdRoot!,
          mdLeaf!,
          f.table_name,
        );
        const perRel = `${CANONICAL_REL}/${f.table_name}/${f.kind}.jsonl`;
        const perAbs = resolveWritablePath(projectKey, "canonical", perRel);
        writeGeneratedText(projectKey, "canonical", perRel, "");
        const perStream = createWriteStream(perAbs, { flags: "a" });

        const enrichRecord =
          f.kind === "structure"
            ? (record: MasterDataCanonicalRecord) => {
                const e = enrichMasterStructureRecord(record);
                if (e._is_z_field === true) zFieldTotal += 1;
                if (e._is_append_include === true) appendIncludeTotal += 1;
                return e;
              }
            : undefined;

        const result = await streamCanonicalizeMasterDataFileWriting({
          absolutePath,
          sourceFileName: f.fileName,
          sourceBytes: f.bytes,
          options: canonOpts,
          enrichRecord,
          writeLine: (line) => {
            perStream.write(`${line}\n`);
            if (f.kind === "content") {
              recordsStream.write(`${line}\n`);
            }
          },
        });
        perStream.end();
        await finished(perStream);

        if (f.kind === "content") contentPaths.set(f.table_name, perAbs);
        else structurePaths.set(f.table_name, perAbs);

        stats = mergeStats(stats, result.stats);
        headers.push(...result.headers);
        outputs.push(perRel);
        perFile.push({
          fileName: f.fileName,
          table_name: f.table_name,
          kind: f.kind,
          export_type: f.export_type,
          schema_version: f.schema_version,
          profile: f.profile,
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

    // Relations metadata + join coverage (content keys only — no PII reconstruction).
    const relationRows: Record<string, unknown>[] = [];
    const relationCounts: Record<string, unknown> = {};
    const parentKeyCache = new Map<string, Set<string>>();

    for (const rel of domain.relations) {
      const base: Record<string, unknown> = {
        relation_id: rel.id,
        kind: rel.kind,
        from_table: rel.from_table,
        to_table: rel.to_table,
        keys: [...rel.keys],
        description: rel.description,
        table_key_fields: {
          [rel.from_table]: domain.tableKeyFields[rel.from_table] ?? [],
          ...(rel.to_table
            ? { [rel.to_table]: domain.tableKeyFields[rel.to_table] ?? [] }
            : {}),
        },
      };

      if (rel.kind === "central") {
        const contentAbs = contentPaths.get(rel.from_table);
        let central_rows = 0;
        if (contentAbs && existsSync(contentAbs)) {
          const set = await collectContentKeySet(contentAbs, rel.keys);
          parentKeyCache.set(`${rel.from_table}:${rel.keys.join(",")}`, set);
          central_rows = set.size;
        }
        relationRows.push({ ...base, central_distinct_keys: central_rows });
        relationCounts[rel.id] = { central_distinct_keys: central_rows };
        continue;
      }

      if (!rel.to_table) {
        relationRows.push(base);
        continue;
      }

      const parentAbs = contentPaths.get(rel.from_table);
      const childAbs = contentPaths.get(rel.to_table);
      const cacheKey = `${rel.from_table}:${rel.keys.join(",")}`;
      let parentSet = parentKeyCache.get(cacheKey);
      if (!parentSet && parentAbs && existsSync(parentAbs)) {
        parentSet = await collectContentKeySet(parentAbs, rel.keys);
        parentKeyCache.set(cacheKey, parentSet);
      }
      parentSet = parentSet ?? new Set();

      let coverage = {
        child_rows: 0,
        matched: 0,
        unmatched: 0,
      };
      if (childAbs && existsSync(childAbs)) {
        coverage = await countJoinCoverage(childAbs, parentSet, rel.keys);
      }
      relationRows.push({
        ...base,
        parent_distinct_keys: parentSet.size,
        ...coverage,
      });
      relationCounts[rel.id] = {
        parent_distinct_keys: parentSet.size,
        ...coverage,
      };
    }

    writeGeneratedText(
      projectKey,
      "canonical",
      `${CANONICAL_REL}/relations.jsonl`,
      relationRows.length
        ? `${relationRows.map((r) => JSON.stringify(r)).join("\n")}\n`
        : "",
    );

    const structureFieldStats: Record<string, unknown> = {};
    let linkedTotal = 0;
    let structureFieldTotal = 0;
    for (const table of domain.tables) {
      const abs = structurePaths.get(table);
      if (!abs) continue;
      const s = countZAndAppend(abs);
      structureFieldStats[table] = s;
      linkedTotal += s.linked_to_content;
      structureFieldTotal += s.total_fields;
    }

    const completeness = assessCompleteness(domain, targets);
    const ok =
      stats.invalid === 0 &&
      stats.key_collisions === 0 &&
      stats.headers >= targets.length &&
      stats.body_records >= 1;

    const headerDoc = {
      source_set: targets.map((f) => ({
        relative: `raw/${domain.rawParts.join("/")}/${f.fileName}`,
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
      observed_tables: domain.tables,
      table_key_fields: domain.tableKeyFields,
      relations: domain.relations,
      certainty: "inferred_from_raw" as const,
      notes: [
        "Mapping aus Header: table_name + export_type MASTER_CONTENT|MASTER_STRUCTURE",
        "Dateiname nur Hinweis — Header maßgeblich",
        "raw/ unverändert; gefilterte PII nicht rekonstruiert",
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
    const convertReportPath = `datenbasis/${domain.exportTypeId}/convert-${id}.json`;
    const contentDocs = perFile
      .filter((p) => p.kind === "content")
      .reduce((s, p) => s + (Number(p.body_records) || 0), 0);
    const structureDocs = perFile
      .filter((p) => p.kind === "structure")
      .reduce((s, p) => s + (Number(p.body_records) || 0), 0);

    const ingestReport = {
      ok,
      started_at: startedAt,
      finished_at: nowIso(),
      project_key: projectKey,
      domain: domain.exportTypeId,
      mode: targets.length > 1 ? "set" : "single",
      completeness,
      per_file: perFile,
      raw_record_counts: Object.fromEntries(
        domain.tables.map((t) => [
          t,
          {
            content:
              Number(
                perFile.find((p) => p.table_name === t && p.kind === "content")
                  ?.body_records,
              ) || 0,
            structure:
              Number(
                perFile.find((p) => p.table_name === t && p.kind === "structure")
                  ?.body_records,
              ) || 0,
          },
        ]),
      ),
      canonical_document_counts: {
        content_rows: contentDocs,
        structure_fields: structureDocs,
        relation_defs: relationRows.length,
      },
      relation_counts: relationCounts,
      z_append_counts: {
        z_fields: zFieldTotal,
        append_includes: appendIncludeTotal,
        linked_to_content: linkedTotal,
        structure_fields_total: structureFieldTotal,
        per_table: structureFieldStats,
      },
      outputs: {
        header: `canonical/${CANONICAL_REL}/header.json`,
        records: `canonical/${CANONICAL_REL}/records.jsonl`,
        relations: `canonical/${CANONICAL_REL}/relations.jsonl`,
        ingest_report: `canonical/${CANONICAL_REL}/ingest_report.json`,
        per_table: perFile.map((p) => p.canonical),
      },
      stats,
      issues: allIssues.slice(0, 100),
      notes: [
        "raw/ unverändert (nur gelesen)",
        "keine OpenAI-Aufrufe",
        "kein Index-Rebuild",
        "classes/materials/control-tables unberührt",
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
      domain.logFileName,
      `[${ingestReport.finished_at}] convert ${domain.exportTypeId} files=${targets.length} ok=${ok} body=${stats.body_records}`,
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
          content_docs: contentDocs,
          structure_docs: structureDocs,
          relations: relationRows.length,
          z_fields: zFieldTotal,
          append_includes: appendIncludeTotal,
          complete: completeness.complete ? 1 : 0,
        },
        errors: missing.length
          ? missing.map((m) => `Fehlt: canonical/${m}`)
          : allIssues.slice(0, 5).map((i) => `${i.file}: ${i.error}`),
        technical: {
          canonical_paths: outputs.map((o) => `canonical/${o}`),
          per_file: perFile,
          completeness,
          relation_counts: relationCounts,
          z_append_counts: ingestReport.z_append_counts,
          record_types: stats.record_types,
          no_openai: true,
          no_index_rebuild: true,
        },
      } satisfies DatenbasisStepResult,
    };
  }

  function buildTestQuestions(projectKey: string) {
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
    const relationsPath = resolveWritablePath(
      projectKey,
      "canonical",
      `${CANONICAL_REL}/relations.jsonl`,
    );
    if (!existsSync(reportPath) || !existsSync(recordsPath)) {
      return {
        ok: false,
        result: {
          summary: `Canonical ${domain.label} fehlen — zuerst konvertieren`,
          ok: false,
          errors: [
            `canonical/${CANONICAL_REL}/ingest_report.json oder records.jsonl fehlt`,
          ],
        } satisfies DatenbasisStepResult,
      };
    }

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      stats?: { body_records?: number };
      completeness?: { complete?: boolean };
      per_file?: Array<{
        table_name?: string;
        kind?: string;
        body_records?: number;
      }>;
      canonical_document_counts?: { relation_defs?: number };
    };
    const body = report.stats?.body_records ?? 0;
    const tables = new Set(
      (report.per_file ?? [])
        .filter((p) => p.kind === "content")
        .map((p) => p.table_name)
        .filter(Boolean),
    );
    const relationDefs = existsSync(relationsPath)
      ? readFileSync(relationsPath, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim()).length
      : 0;

    const cases = [
      {
        question: `Wie viele Content-Datensätze liegen in canonical/${CANONICAL_REL}/records.jsonl?`,
        ok: body > 0,
        detail: String(body),
      },
      {
        question: `Sind alle Tabellen ${domain.tables.join("/")} im Set vertreten?`,
        ok: domain.tables.every((t) => tables.has(t)),
        detail: [...tables].sort().join(","),
      },
      {
        question: `Ist das ${domain.label}-RAW-Set vollständig (STRUCTURE+CONTENT je Tabelle)?`,
        ok: Boolean(report.completeness?.complete),
        detail: String(report.completeness?.complete ?? false),
      },
      {
        question: `Sind Relations-Metadaten vorhanden?`,
        ok: relationDefs >= domain.relations.length,
        detail: String(relationDefs),
      },
    ];

    return {
      ok: cases.every((c) => c.ok),
      result: {
        summary: `${cases.length} Testfragen aus Canonical (body=${body})`,
        ok: cases.every((c) => c.ok),
        cases,
        technical: { no_openai: true },
      } satisfies DatenbasisStepResult,
    };
  }

  async function runRagTestSkipped() {
    return {
      ok: true,
      result: {
        summary: `RAG-Test übersprungen — kein ${domain.label}-Index/Embeddings (bewusst, kein OpenAI)`,
        ok: true,
        technical: {
          skipped: true,
          reason: `no_${domain.exportTypeId}_index`,
          no_openai: true,
        },
      } satisfies DatenbasisStepResult,
    };
  }

  return {
    domain,
    detectRaw,
    validateJsonl,
    convert,
    buildTestQuestions,
    runRagTestSkipped,
  };
}
