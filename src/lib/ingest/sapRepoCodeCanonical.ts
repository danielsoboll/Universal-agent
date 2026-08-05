/**
 * Shared streaming RAW → canonical for SAP_PROGRAMS / SAP_FUNCTION_MODULES.
 * Detect/validate/convert shape matches classes/materials (no OpenAI, no index).
 *
 * RAW record types (schema 2.2 evidence):
 *   header | source_object | code_unit | relation
 */

import { createHash } from "crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "fs";
import { createInterface } from "readline";
import { finished } from "stream/promises";
import type { WriteStream } from "fs";
import { splitAbapCodeUnits } from "@/lib/ingest/sapAbapUnitSplit";
import {
  extractProgramArtifacts,
  type ProgramExtract,
} from "@/lib/ingest/sapProgramExtract";

export const REPO_CODE_RECORD_TYPES = [
  "header",
  "source_object",
  "code_unit",
  "relation",
] as const;

export type RepoCodeRecordType = (typeof REPO_CODE_RECORD_TYPES)[number];

export type RepoCodeDomain = {
  id: "programs" | "function-modules";
  /** Exact header.export_type */
  expectedExportType: "SAP_PROGRAMS" | "SAP_FUNCTION_MODULES";
  expectedObjectType: "PROGRAM" | "FUNCTION_MODULE";
  canonicalDir: "programs" | "function-modules";
  titleDe: string;
};

export const PROGRAMS_DOMAIN: RepoCodeDomain = {
  id: "programs",
  expectedExportType: "SAP_PROGRAMS",
  expectedObjectType: "PROGRAM",
  canonicalDir: "programs",
  titleDe: "Programme",
};

export const FUNCTION_MODULES_DOMAIN: RepoCodeDomain = {
  id: "function-modules",
  expectedExportType: "SAP_FUNCTION_MODULES",
  expectedObjectType: "FUNCTION_MODULE",
  canonicalDir: "function-modules",
  titleDe: "Funktionsbausteine",
};

export type RepoCodeStats = {
  lines_total: number;
  blank_lines: number;
  valid: number;
  invalid: number;
  headers: number;
  source_objects: number;
  raw_code_units: number;
  derived_code_units: number;
  code_units_total: number;
  relations_raw: number;
  relations_derived: number;
  relations_total: number;
  extracts: number;
  duplicates: number;
  key_collisions: number;
  record_types: Record<string, number>;
  unit_types: Record<string, number>;
  relation_types: Record<string, number>;
  tables_read_refs: number;
  tables_write_refs: number;
  call_function_refs: number;
  perform_refs: number;
  include_refs: number;
  zy_table_refs: number;
  hardcoded_refs: number;
};

export type RepoCodeLineIssue = {
  lineNumber: number;
  error: string;
  code?: "INVALID_JSON" | "SCHEMA" | "KEY_COLLISION" | "HEADER" | "EMPTY";
  rawPreview: string;
  canonicalKey?: string;
};

export type RawRef = {
  file_name: string;
  file_sha256: string;
  record_line: number;
  record_type: string;
  source_key: string | null;
  parent_unit_key?: string;
  source_start_line?: number;
  source_end_line?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function preview(line: string, max = 160): string {
  const t = line.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function isRecordType(value: unknown): value is RepoCodeRecordType {
  return (
    typeof value === "string" &&
    (REPO_CODE_RECORD_TYPES as readonly string[]).includes(value)
  );
}

function emptyStats(): RepoCodeStats {
  return {
    lines_total: 0,
    blank_lines: 0,
    valid: 0,
    invalid: 0,
    headers: 0,
    source_objects: 0,
    raw_code_units: 0,
    derived_code_units: 0,
    code_units_total: 0,
    relations_raw: 0,
    relations_derived: 0,
    relations_total: 0,
    extracts: 0,
    duplicates: 0,
    key_collisions: 0,
    record_types: {},
    unit_types: {},
    relation_types: {},
    tables_read_refs: 0,
    tables_write_refs: 0,
    call_function_refs: 0,
    perform_refs: 0,
    include_refs: 0,
    zy_table_refs: 0,
    hardcoded_refs: 0,
  };
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function validateRecord(
  recordType: RepoCodeRecordType,
  obj: Record<string, unknown>,
  domain: RepoCodeDomain,
): string | null {
  if (!asNonEmptyString(obj.schema_version)) {
    return "schema_version fehlt oder ist leer";
  }
  if (!asNonEmptyString(obj.system_id)) {
    return "system_id fehlt oder ist leer";
  }

  switch (recordType) {
    case "header":
      if (!asNonEmptyString(obj.export_type)) return "header: export_type fehlt";
      if (asNonEmptyString(obj.export_type) !== domain.expectedExportType) {
        return `header: export_type erwartet ${domain.expectedExportType}, erhalten ${String(obj.export_type)}`;
      }
      return null;
    case "source_object":
      if (!asNonEmptyString(obj.source_key)) return "source_object: source_key fehlt";
      if (!asNonEmptyString(obj.object_type)) return "source_object: object_type fehlt";
      if (!asNonEmptyString(obj.object_name)) return "source_object: object_name fehlt";
      return null;
    case "code_unit":
      if (!asNonEmptyString(obj.source_key)) return "code_unit: source_key fehlt";
      if (!asNonEmptyString(obj.object_type)) return "code_unit: object_type fehlt";
      if (!asNonEmptyString(obj.object_name)) return "code_unit: object_name fehlt";
      if (!asNonEmptyString(obj.unit_type)) return "code_unit: unit_type fehlt";
      if (typeof obj.source_code !== "string") return "code_unit: source_code fehlt";
      return null;
    case "relation":
      if (!asNonEmptyString(obj.from_type)) return "relation: from_type fehlt";
      if (!asNonEmptyString(obj.from_name)) return "relation: from_name fehlt";
      if (!asNonEmptyString(obj.relation_type)) return "relation: relation_type fehlt";
      if (!asNonEmptyString(obj.to_type)) return "relation: to_type fehlt";
      if (!asNonEmptyString(obj.to_name)) return "relation: to_name fehlt";
      return null;
    default:
      return `Unbekannter record_type`;
  }
}

function canonicalKeyFor(
  recordType: RepoCodeRecordType,
  obj: Record<string, unknown>,
): string {
  if (recordType === "header") {
    return ["header", obj.system_id, obj.export_type, obj.schema_version].join(
      "|",
    );
  }
  if (recordType === "relation") {
    return [
      "relation",
      obj.system_id,
      obj.from_type,
      obj.from_name,
      obj.relation_type,
      obj.to_type,
      obj.to_name,
      typeof obj.metadata === "string"
        ? obj.metadata
        : JSON.stringify(obj.metadata ?? null),
    ].join("|");
  }
  if (recordType === "code_unit") {
    const sourceKey = asNonEmptyString(obj.source_key);
    const includeName = asNonEmptyString(obj.include_name);
    const unitType = asNonEmptyString(obj.unit_type);
    const unitName = asNonEmptyString(obj.unit_name);
    if (sourceKey && unitType && unitName) {
      return `code_unit|${sourceKey}|${unitType}|${unitName}|${includeName ?? ""}`;
    }
    if (sourceKey && includeName) return `code_unit|${sourceKey}|${includeName}`;
    if (sourceKey) return `code_unit|${sourceKey}`;
    return `code_unit|${sha256Hex(JSON.stringify(obj))}`;
  }
  const sourceKey = asNonEmptyString(obj.source_key);
  if (sourceKey) return `${recordType}|${sourceKey}`;
  return `${recordType}|${sha256Hex(JSON.stringify(obj))}`;
}

function contentHashFor(
  recordType: RepoCodeRecordType,
  obj: Record<string, unknown>,
): string {
  if (recordType === "code_unit") {
    const code = typeof obj.source_code === "string" ? obj.source_code : "";
    return sha256Hex(code);
  }
  return sha256Hex(JSON.stringify(obj));
}

function writeJsonlLine(stream: WriteStream, obj: Record<string, unknown>) {
  stream.write(`${JSON.stringify(obj)}\n`);
}

function buildExtractRelations(params: {
  systemId: string;
  objectType: string;
  objectName: string;
  unitKey: string;
  unitType: string;
  unitName: string;
  extract: ProgramExtract;
}): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const base = {
    schema_version: "canonical-1",
    record_type: "relation",
    system_id: params.systemId,
    _derived: true,
    _from_unit_key: params.unitKey,
  };

  for (const form of params.extract.perform) {
    out.push({
      ...base,
      from_type: params.unitType,
      from_name: params.unitName,
      relation_type: "PERFORMS",
      to_type: "FORM",
      to_name: form,
      metadata: params.objectName,
    });
  }
  for (const fm of params.extract.call_function) {
    out.push({
      ...base,
      from_type: params.unitType,
      from_name: params.unitName,
      relation_type: "CALLS_FUNCTION",
      to_type: "FUNCTION_MODULE",
      to_name: fm,
      metadata: params.objectName,
    });
  }
  for (const meth of params.extract.call_method) {
    out.push({
      ...base,
      from_type: params.unitType,
      from_name: params.unitName,
      relation_type: "CALLS_METHOD",
      to_type: "METHOD",
      to_name: meth,
      metadata: params.objectName,
    });
  }
  for (const inc of params.extract.include) {
    out.push({
      ...base,
      from_type: params.objectType,
      from_name: params.objectName,
      relation_type: "INCLUDES",
      to_type: "INCLUDE",
      to_name: inc,
      metadata: "from_source",
    });
  }
  for (const t of params.extract.tables_read) {
    out.push({
      ...base,
      from_type: "CODE_UNIT",
      from_name: params.unitKey,
      relation_type: "READS_TABLE",
      to_type: "TABLE",
      to_name: t,
      metadata: params.objectName,
    });
  }
  for (const t of params.extract.tables_written) {
    out.push({
      ...base,
      from_type: "CODE_UNIT",
      from_name: params.unitKey,
      relation_type: "WRITES_TABLE",
      to_type: "TABLE",
      to_name: t,
      metadata: params.objectName,
    });
  }
  for (const form of splitFormDefs(params)) {
    out.push({
      ...base,
      from_type: params.objectType,
      from_name: params.objectName,
      relation_type: "DEFINES_FORM",
      to_type: "FORM",
      to_name: form,
      metadata: params.unitKey,
    });
  }
  return out;
}

function splitFormDefs(params: {
  unitType: string;
  unitName: string;
}): string[] {
  if (params.unitType.toUpperCase() === "FORM") return [params.unitName];
  return [];
}

export type StreamCanonicalizeResult = {
  domain: RepoCodeDomain;
  sourceFileName: string;
  sourceBytes: number;
  fileSha256: string;
  stats: RepoCodeStats;
  issues: RepoCodeLineIssue[];
  header: Record<string, unknown> | null;
  headerCounts: {
    object_count: number | null;
    source_count: number | null;
    relation_count: number | null;
  };
  plausible: { ok: boolean; notes: string[] };
  unitsMissingRawRef: number;
};

type Writers = {
  sourceObjects: WriteStream;
  codeUnits: WriteStream;
  relations: WriteStream;
  extracts: WriteStream;
};

/**
 * Stream RAW JSONL → canonical artifacts (readline; one record at a time).
 * Splits FULL_PROGRAM / FUNCTION into FORM/MODULE/CLASS/METHOD sub-units.
 */
export async function streamCanonicalizeRepoCode(params: {
  domain: RepoCodeDomain;
  absolutePath: string;
  sourceFileName: string;
  sourceBytes: number;
  writers?: Writers;
  /** validate-only: count/check without writing derived extras beyond stats */
  writeArtifacts?: boolean;
}): Promise<StreamCanonicalizeResult> {
  const { domain } = params;
  const writeArtifacts = params.writeArtifacts !== false && Boolean(params.writers);
  const writers = params.writers;
  const stats = emptyStats();
  const issues: RepoCodeLineIssue[] = [];
  const seen = new Map<string, { contentHash: string; lineNumber: number }>();
  const fileHash = createHash("sha256");
  let header: Record<string, unknown> | null = null;
  let unitsMissingRawRef = 0;

  const rl = createInterface({
    input: createReadStream(params.absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  try {
    for await (const line of rl) {
      lineNumber += 1;
      fileHash.update(line);
      fileHash.update("\n");

      if (line.trim() === "") {
        stats.blank_lines += 1;
        continue;
      }
      stats.lines_total += 1;

      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        stats.invalid += 1;
        issues.push({
          lineNumber,
          code: "INVALID_JSON",
          error: error instanceof Error ? error.message : "JSON ungültig",
          rawPreview: preview(line),
        });
        continue;
      }

      if (!isPlainObject(value)) {
        stats.invalid += 1;
        issues.push({
          lineNumber,
          code: "SCHEMA",
          error: "Zeile ist kein JSON-Objekt",
          rawPreview: preview(line),
        });
        continue;
      }

      if (!isRecordType(value.record_type)) {
        stats.invalid += 1;
        issues.push({
          lineNumber,
          code: "SCHEMA",
          error: `Ungültiger record_type: ${String(value.record_type)}`,
          rawPreview: preview(line),
        });
        continue;
      }

      const recordType = value.record_type;
      bump(stats.record_types, recordType);

      const schemaError = validateRecord(recordType, value, domain);
      if (schemaError) {
        stats.invalid += 1;
        issues.push({
          lineNumber,
          code: recordType === "header" ? "HEADER" : "SCHEMA",
          error: schemaError,
          rawPreview: preview(line),
        });
        continue;
      }

      const key = canonicalKeyFor(recordType, value);
      const contentHash = contentHashFor(recordType, value);
      const prev = seen.get(key);
      if (prev) {
        if (prev.contentHash === contentHash) {
          stats.duplicates += 1;
          continue;
        }
        stats.key_collisions += 1;
        issues.push({
          lineNumber,
          code: "KEY_COLLISION",
          canonicalKey: key,
          error: `KEY_COLLISION mit Zeile ${prev.lineNumber}: ${key}`,
          rawPreview: preview(line),
        });
        continue;
      }
      seen.set(key, { contentHash, lineNumber });
      stats.valid += 1;

      const fileShaSoFar = ""; // filled after stream; refs use final hash post-pass placeholder
      void fileShaSoFar;

      if (recordType === "header") {
        header = value;
        stats.headers += 1;
        continue;
      }

      if (recordType === "source_object") {
        stats.source_objects += 1;
        if (writeArtifacts && writers) {
          const rawRef: RawRef = {
            file_name: params.sourceFileName,
            file_sha256: "PENDING",
            record_line: lineNumber,
            record_type: "source_object",
            source_key: asNonEmptyString(value.source_key),
          };
          writeJsonlLine(writers.sourceObjects, {
            ...value,
            _canonical_key: key,
            _content_sha256: contentHash,
            _raw_ref: rawRef,
          });
        }
        continue;
      }

      if (recordType === "relation") {
        stats.relations_raw += 1;
        bump(stats.relation_types, String(value.relation_type));
        if (writeArtifacts && writers) {
          writeJsonlLine(writers.relations, {
            ...value,
            _canonical_key: key,
            _content_sha256: contentHash,
            _raw_ref: {
              file_name: params.sourceFileName,
              file_sha256: "PENDING",
              record_line: lineNumber,
              record_type: "relation",
              source_key: null,
            } satisfies RawRef,
            _derived: false,
          });
        }
        continue;
      }

      // code_unit
      stats.raw_code_units += 1;
      const systemId = asNonEmptyString(value.system_id) ?? "";
      const objectType = asNonEmptyString(value.object_type) ?? "";
      const objectName = asNonEmptyString(value.object_name) ?? "";
      const unitType = asNonEmptyString(value.unit_type) ?? "OTHER";
      const unitName =
        asNonEmptyString(value.unit_name) ?? objectName ?? "UNKNOWN";
      const sourceCode =
        typeof value.source_code === "string" ? value.source_code : "";
      const includeName = asNonEmptyString(value.include_name);
      const parentKey = key;
      bump(stats.unit_types, unitType);

      const parentRawRef: RawRef = {
        file_name: params.sourceFileName,
        file_sha256: "PENDING",
        record_line: lineNumber,
        record_type: "code_unit",
        source_key: asNonEmptyString(value.source_key),
      };

      if (!parentRawRef.source_key && !parentRawRef.record_line) {
        unitsMissingRawRef += 1;
      }

      const parentUnit = {
        ...value,
        _canonical_key: parentKey,
        _content_sha256: contentHash,
        _raw_ref: parentRawRef,
        _derived: false,
        _unit_role: "main",
      };

      if (writeArtifacts && writers) {
        writeJsonlLine(writers.codeUnits, parentUnit);
      }
      stats.code_units_total += 1;

      // Extracts + derived relations for main unit
      const mainExtract = extractProgramArtifacts(sourceCode);
      emitExtractAndRelations({
        writeArtifacts: writeArtifacts && Boolean(writers),
        writers,
        stats,
        seen,
        systemId,
        objectType,
        objectName,
        unitKey: parentKey,
        unitType,
        unitName,
        extract: mainExtract,
        rawRef: parentRawRef,
      });

      // Split sub-units (FORM/MODULE/CLASS/METHOD/FUNCTION)
      const splits = splitAbapCodeUnits(sourceCode);
      for (const split of splits) {
        // Skip if identical to the RAW main unit envelope
        if (
          split.unit_type === unitType.toUpperCase() &&
          split.unit_name === unitName.toUpperCase() &&
          split.start_line === 1 &&
          split.end_line >= (typeof value.line_count === "number"
            ? value.line_count
            : split.end_line)
        ) {
          continue;
        }
        // Always emit FORM/MODULE/METHOD/CLASS; emit FUNCTION only when domain is FM
        // and it's nested differently — keep all non-identical splits.
        const derivedKey = [
          "code_unit",
          asNonEmptyString(value.source_key) ?? objectName,
          split.unit_type,
          split.unit_name,
          includeName ?? "",
          `L${split.start_line}-${split.end_line}`,
        ].join("|");

        if (seen.has(derivedKey)) {
          stats.duplicates += 1;
          continue;
        }
        const derivedHash = sha256Hex(split.source_code);
        seen.set(derivedKey, { contentHash: derivedHash, lineNumber });

        const derivedRawRef: RawRef = {
          ...parentRawRef,
          parent_unit_key: parentKey,
          source_start_line: split.start_line,
          source_end_line: split.end_line,
        };

        const derivedUnit: Record<string, unknown> = {
          schema_version: asNonEmptyString(value.schema_version) ?? "2.2",
          record_type: "code_unit",
          system_id: systemId,
          source_key: asNonEmptyString(value.source_key),
          object_type: objectType,
          object_name: objectName,
          unit_type: split.unit_type,
          unit_name: split.unit_name,
          include_name: includeName,
          fragment_type: `SPLIT_${split.unit_type}`,
          line_count: split.line_count,
          language: asNonEmptyString(value.language) ?? "ABAP",
          source_code: split.source_code,
          _canonical_key: derivedKey,
          _content_sha256: derivedHash,
          _raw_ref: derivedRawRef,
          _derived: true,
          _unit_role: "split",
          _parent_canonical_key: parentKey,
        };

        if (!derivedRawRef.file_name || !derivedRawRef.record_line) {
          unitsMissingRawRef += 1;
        }

        if (writeArtifacts && writers) {
          writeJsonlLine(writers.codeUnits, derivedUnit);
        }
        stats.derived_code_units += 1;
        stats.code_units_total += 1;
        bump(stats.unit_types, split.unit_type);

        const splitExtract = extractProgramArtifacts(split.source_code);
        emitExtractAndRelations({
          writeArtifacts: writeArtifacts && Boolean(writers),
          writers,
          stats,
          seen,
          systemId,
          objectType,
          objectName,
          unitKey: derivedKey,
          unitType: split.unit_type,
          unitName: split.unit_name,
          extract: splitExtract,
          rawRef: derivedRawRef,
        });

        // program/FM → FORM relation when split is FORM
        if (split.unit_type === "FORM" && writeArtifacts && writers) {
          const rel = {
            schema_version: "canonical-1",
            record_type: "relation",
            system_id: systemId,
            from_type: objectType,
            from_name: objectName,
            relation_type: "DEFINES_FORM",
            to_type: "FORM",
            to_name: split.unit_name,
            metadata: derivedKey,
            _derived: true,
            _canonical_key: `relation|${systemId}|${objectType}|${objectName}|DEFINES_FORM|FORM|${split.unit_name}|${derivedKey}`,
          };
          const relKey = String(rel._canonical_key);
          if (!seen.has(relKey)) {
            seen.set(relKey, { contentHash: sha256Hex(JSON.stringify(rel)), lineNumber });
            writeJsonlLine(writers.relations, rel);
            stats.relations_derived += 1;
            bump(stats.relation_types, "DEFINES_FORM");
          }
        }
      }

      // FM: function module ↔ function group ↔ include
      if (
        domain.id === "function-modules" &&
        writeArtifacts &&
        writers &&
        objectType === "FUNCTION_MODULE"
      ) {
        // main_program comes from source_object; we only have include_name here.
        // Link code unit → include when present.
        if (includeName) {
          const rel = {
            schema_version: "canonical-1",
            record_type: "relation",
            system_id: systemId,
            from_type: "FUNCTION_MODULE",
            from_name: objectName,
            relation_type: "IMPLEMENTED_IN_INCLUDE",
            to_type: "INCLUDE",
            to_name: includeName,
            metadata: parentKey,
            _derived: true,
            _canonical_key: `relation|${systemId}|FUNCTION_MODULE|${objectName}|IMPLEMENTED_IN_INCLUDE|INCLUDE|${includeName}`,
          };
          const relKey = String(rel._canonical_key);
          if (!seen.has(relKey)) {
            seen.set(relKey, {
              contentHash: sha256Hex(JSON.stringify(rel)),
              lineNumber,
            });
            writeJsonlLine(writers.relations, rel);
            stats.relations_derived += 1;
            bump(stats.relation_types, "IMPLEMENTED_IN_INCLUDE");
          }
        }
      }
    }
  } finally {
    rl.close();
  }

  const fileSha256 = fileHash.digest("hex");
  stats.relations_total = stats.relations_raw + stats.relations_derived;

  const headerCounts = {
    object_count:
      header && typeof header.object_count === "number"
        ? header.object_count
        : null,
    source_count:
      header && typeof header.source_count === "number"
        ? header.source_count
        : null,
    relation_count:
      header && typeof header.relation_count === "number"
        ? header.relation_count
        : null,
  };

  const notes: string[] = [];
  let plausibleOk = true;
  if (!header) {
    plausibleOk = false;
    notes.push("Kein Header");
  }
  if (
    headerCounts.object_count != null &&
    headerCounts.object_count !== stats.source_objects
  ) {
    plausibleOk = false;
    notes.push(
      `object_count Header=${headerCounts.object_count} ≠ source_objects=${stats.source_objects}`,
    );
  }
  if (
    headerCounts.source_count != null &&
    headerCounts.source_count !== stats.raw_code_units
  ) {
    plausibleOk = false;
    notes.push(
      `source_count Header=${headerCounts.source_count} ≠ raw_code_units=${stats.raw_code_units}`,
    );
  }
  if (
    headerCounts.relation_count != null &&
    headerCounts.relation_count !== stats.relations_raw
  ) {
    plausibleOk = false;
    notes.push(
      `relation_count Header=${headerCounts.relation_count} ≠ relations_raw=${stats.relations_raw}`,
    );
  }
  if (stats.source_objects < 1 || stats.raw_code_units < 1) {
    plausibleOk = false;
    notes.push("Keine source_objects/code_units");
  }
  if (plausibleOk) notes.push("Header-Zähler stimmen mit Streaming-Counts");

  return {
    domain,
    sourceFileName: params.sourceFileName,
    sourceBytes: params.sourceBytes,
    fileSha256,
    stats,
    issues,
    header,
    headerCounts,
    plausible: { ok: plausibleOk, notes },
    unitsMissingRawRef,
  };
}

function emitExtractAndRelations(params: {
  writeArtifacts: boolean;
  writers?: Writers;
  stats: RepoCodeStats;
  seen: Map<string, { contentHash: string; lineNumber: number }>;
  systemId: string;
  objectType: string;
  objectName: string;
  unitKey: string;
  unitType: string;
  unitName: string;
  extract: ProgramExtract;
  rawRef: RawRef;
}) {
  const { stats, extract } = params;
  stats.extracts += 1;
  stats.tables_read_refs += extract.tables_read.length;
  stats.tables_write_refs += extract.tables_written.length;
  stats.call_function_refs += extract.call_function.length;
  stats.perform_refs += extract.perform.length;
  stats.include_refs += extract.include.length;
  stats.zy_table_refs += extract.tables_zy.length;
  stats.hardcoded_refs += extract.hardcoded_values.length;

  if (!params.writeArtifacts || !params.writers) return;

  writeJsonlLine(params.writers.extracts, {
    record_type: "extract",
    unit_key: params.unitKey,
    object_type: params.objectType,
    object_name: params.objectName,
    unit_type: params.unitType,
    unit_name: params.unitName,
    _raw_ref: params.rawRef,
    ...extract,
  });

  const rels = buildExtractRelations({
    systemId: params.systemId,
    objectType: params.objectType,
    objectName: params.objectName,
    unitKey: params.unitKey,
    unitType: params.unitType,
    unitName: params.unitName,
    extract,
  });
  for (const rel of rels) {
    const relKey =
      typeof rel._canonical_key === "string"
        ? rel._canonical_key
        : canonicalKeyFor("relation", rel);
    if (params.seen.has(relKey)) {
      stats.duplicates += 1;
      continue;
    }
    params.seen.set(relKey, {
      contentHash: sha256Hex(JSON.stringify(rel)),
      lineNumber: 0,
    });
    writeJsonlLine(params.writers.relations, {
      ...rel,
      _canonical_key: relKey,
    });
    stats.relations_derived += 1;
    bump(stats.relation_types, String(rel.relation_type));
  }
}

export function repoCodeValidationOk(result: StreamCanonicalizeResult): boolean {
  return (
    result.stats.invalid === 0 &&
    result.stats.key_collisions === 0 &&
    result.stats.headers >= 1 &&
    result.plausible.ok &&
    result.unitsMissingRawRef === 0
  );
}

/** Patch PENDING file_sha256 in written JSONL (second pass streaming). */
export async function patchFileSha256InJsonl(
  absolutePath: string,
  fileSha256: string,
): Promise<number> {
  if (!existsSync(absolutePath)) return 0;
  const tmp = `${absolutePath}.tmp`;
  const out = createWriteStream(tmp, { encoding: "utf8" });
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let n = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const ref = obj._raw_ref;
        if (isPlainObject(ref) && ref.file_sha256 === "PENDING") {
          ref.file_sha256 = fileSha256;
          obj._raw_ref = ref;
        }
        out.write(`${JSON.stringify(obj)}\n`);
        n += 1;
      } catch {
        out.write(`${line}\n`);
        n += 1;
      }
    }
  } finally {
    rl.close();
    out.end();
    await finished(out);
  }
  const { renameSync } = await import("fs");
  renameSync(tmp, absolutePath);
  return n;
}

export async function countJsonlRecords(absolutePath: string): Promise<number> {
  if (!existsSync(absolutePath)) return 0;
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let n = 0;
  try {
    for await (const line of rl) {
      if (line.trim()) n += 1;
    }
  } finally {
    rl.close();
  }
  return n;
}

export async function verifyEveryUnitHasRawRef(
  absolutePath: string,
): Promise<{ ok: boolean; missing: number; total: number }> {
  if (!existsSync(absolutePath)) {
    return { ok: false, missing: 0, total: 0 };
  }
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let total = 0;
  let missing = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      total += 1;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const ref = obj._raw_ref;
        if (
          !isPlainObject(ref) ||
          !asNonEmptyString(ref.file_name) ||
          typeof ref.record_line !== "number" ||
          !asNonEmptyString(ref.file_sha256) ||
          ref.file_sha256 === "PENDING"
        ) {
          missing += 1;
        }
      } catch {
        missing += 1;
      }
    }
  } finally {
    rl.close();
  }
  return { ok: missing === 0 && total > 0, missing, total };
}

export function openCanonicalWriters(paths: {
  sourceObjects: string;
  codeUnits: string;
  relations: string;
  extracts: string;
}): Writers {
  // Truncate by opening with 'w'
  return {
    sourceObjects: createWriteStream(paths.sourceObjects, { flags: "w" }),
    codeUnits: createWriteStream(paths.codeUnits, { flags: "w" }),
    relations: createWriteStream(paths.relations, { flags: "w" }),
    extracts: createWriteStream(paths.extracts, { flags: "w" }),
  };
}

export async function closeWriters(writers: Writers): Promise<void> {
  for (const s of [
    writers.sourceObjects,
    writers.codeUnits,
    writers.relations,
    writers.extracts,
  ]) {
    s.end();
    await finished(s);
  }
}

export function fileBytes(absolutePath: string): number {
  return existsSync(absolutePath) ? statSync(absolutePath).size : 0;
}
