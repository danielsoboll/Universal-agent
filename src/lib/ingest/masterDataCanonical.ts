/**
 * Deterministic master-data RAW → canonical (shared for materials/customers/vendors).
 *
 * Evidence (P01 raw/master-data/*, 2026-08-04):
 * - Header export_type: MASTER_CONTENT | MASTER_STRUCTURE
 * - Header table_name + profile (MATERIAL | CUSTOMER | VENDOR)
 * - Body CONTENT: record_type=master_data_row + values{} (+ row_number)
 * - Body STRUCTURE: record_type=master_field_definition + field_name
 */

import { createHash } from "crypto";
import { createReadStream } from "fs";
import { createInterface } from "readline";

export type MasterDataCanonicalStats = {
  lines_total: number;
  blank_lines: number;
  valid: number;
  invalid: number;
  headers: number;
  body_records: number;
  duplicates: number;
  key_collisions: number;
  record_types: Record<string, number>;
};

export type MasterDataLineIssue = {
  lineNumber: number;
  error: string;
  code?: "INVALID_JSON" | "SCHEMA" | "KEY_COLLISION" | "EMPTY";
  rawPreview: string;
  canonicalKey?: string;
};

export type MasterDataCanonicalRecord = Record<string, unknown> & {
  _canonical_key: string;
  _source_line: number;
  _content_sha256: string;
};

export type MasterDataCanonicalResult = {
  sourceFileName: string;
  sourceBytes: number;
  stats: MasterDataCanonicalStats;
  issues: MasterDataLineIssue[];
  headers: Record<string, unknown>[];
  records: MasterDataCanonicalRecord[];
  observed_export_type: string | null;
  observed_system_id: string | null;
  observed_schema_version: string | null;
  observed_table_name: string | null;
  observed_profile: string | null;
};

export type MasterDataCanonicalOptions = {
  /** Prefer these values{} keys when row_number / field_name absent. */
  contentKeyFields?: readonly string[];
};

type Acc = {
  stats: MasterDataCanonicalStats;
  issues: MasterDataLineIssue[];
  headers: Record<string, unknown>[];
  records: MasterDataCanonicalRecord[];
  seenKeys: Map<string, { line: number; contentSha: string }>;
  observed_export_type: string | null;
  observed_system_id: string | null;
  observed_schema_version: string | null;
  observed_table_name: string | null;
  observed_profile: string | null;
  omitRecords: boolean;
  contentKeyFields: readonly string[];
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

/**
 * Stable identity from fields present on real exports (no invented column set).
 * Prefers table_name + row_number / field_name / values keys / top-level ids.
 */
function deriveCanonicalKey(
  obj: Record<string, unknown>,
  contentSha: string,
  contentKeyFields: readonly string[],
): string {
  const table = asNonEmptyString(obj.table_name) ?? "table";
  const rt = asNonEmptyString(obj.record_type) ?? "record";

  if (typeof obj.row_number === "number" && Number.isFinite(obj.row_number)) {
    return `${table}:${rt}:row:${obj.row_number}`;
  }

  const fieldName = asNonEmptyString(obj.field_name);
  if (fieldName) {
    // STRUCTURE exports can repeat field_name (e.g. ".INCLU--AP"); position is unique.
    if (typeof obj.position === "number" && Number.isFinite(obj.position)) {
      return `${table}:${rt}:field:${fieldName}:pos:${obj.position}`;
    }
    return `${table}:${rt}:field:${fieldName}`;
  }

  const values = isPlainObject(obj.values) ? obj.values : null;
  if (values) {
    const parts: string[] = [];
    for (const k of contentKeyFields) {
      const v = asNonEmptyString(values[k]);
      if (v) parts.push(`${k}=${v}`);
    }
    if (parts.length > 0) {
      return `${table}:${rt}:${parts.join("|")}`;
    }
  }

  const candidates = [
    "canonical_key",
    "source_key",
    "object_key",
    "row_key",
    ...contentKeyFields,
  ];
  for (const key of candidates) {
    const v = asNonEmptyString(obj[key]);
    if (v) {
      return `${table}:${rt}:${v}`;
    }
  }
  return `${table}:${rt}:sha256:${contentSha.slice(0, 24)}`;
}

function validateHeaderShape(obj: Record<string, unknown>): string | null {
  if (asNonEmptyString(obj.record_type) !== "header") {
    return "header: record_type muss \"header\" sein";
  }
  if (!asNonEmptyString(obj.export_type)) {
    return "header: export_type fehlt oder ist leer";
  }
  if (!asNonEmptyString(obj.system_id)) {
    return "header: system_id fehlt oder ist leer";
  }
  if (!asNonEmptyString(obj.schema_version)) {
    return "header: schema_version fehlt oder ist leer";
  }
  return null;
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

function createAcc(
  omitRecords: boolean,
  contentKeyFields: readonly string[],
): Acc {
  return {
    stats: emptyStats(),
    issues: [],
    headers: [],
    records: [],
    seenKeys: new Map(),
    observed_export_type: null,
    observed_system_id: null,
    observed_schema_version: null,
    observed_table_name: null,
    observed_profile: null,
    omitRecords,
    contentKeyFields,
  };
}

function ingestLine(
  acc: Acc,
  lineNumber: number,
  line: string,
  onBodyRecord?: (record: MasterDataCanonicalRecord) => void,
): void {
  acc.stats.lines_total += 1;
  const trimmed = line.trim();
  if (!trimmed) {
    acc.stats.blank_lines += 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    acc.stats.invalid += 1;
    acc.issues.push({
      lineNumber,
      error: "Ungültiges JSON",
      code: "INVALID_JSON",
      rawPreview: preview(trimmed),
    });
    return;
  }

  if (!isPlainObject(parsed)) {
    acc.stats.invalid += 1;
    acc.issues.push({
      lineNumber,
      error: "Zeile ist kein JSON-Objekt",
      code: "SCHEMA",
      rawPreview: preview(trimmed),
    });
    return;
  }

  const recordType = asNonEmptyString(parsed.record_type);
  if (!recordType) {
    acc.stats.invalid += 1;
    acc.issues.push({
      lineNumber,
      error: "record_type fehlt oder ist leer",
      code: "SCHEMA",
      rawPreview: preview(trimmed),
    });
    return;
  }

  if (recordType === "header") {
    const err = validateHeaderShape(parsed);
    if (err) {
      acc.stats.invalid += 1;
      acc.issues.push({
        lineNumber,
        error: err,
        code: "SCHEMA",
        rawPreview: preview(trimmed),
      });
      return;
    }
    acc.stats.valid += 1;
    acc.stats.headers += 1;
    acc.stats.record_types.header = (acc.stats.record_types.header ?? 0) + 1;
    acc.headers.push(parsed);
    if (!acc.observed_export_type) {
      acc.observed_export_type = asNonEmptyString(parsed.export_type);
      acc.observed_system_id = asNonEmptyString(parsed.system_id);
      acc.observed_schema_version = asNonEmptyString(parsed.schema_version);
      acc.observed_table_name = asNonEmptyString(parsed.table_name);
      acc.observed_profile = asNonEmptyString(parsed.profile);
    }
    return;
  }

  const contentSha = sha256Hex(trimmed);
  const canonicalKey = deriveCanonicalKey(
    parsed,
    contentSha,
    acc.contentKeyFields,
  );
  const prior = acc.seenKeys.get(canonicalKey);
  if (prior) {
    if (prior.contentSha === contentSha) {
      acc.stats.duplicates += 1;
      acc.stats.valid += 1;
      acc.stats.record_types[recordType] =
        (acc.stats.record_types[recordType] ?? 0) + 1;
      return;
    }
    acc.stats.invalid += 1;
    acc.stats.key_collisions += 1;
    acc.issues.push({
      lineNumber,
      error: `Schlüsselkollision: ${canonicalKey} (zuerst Z.${prior.line})`,
      code: "KEY_COLLISION",
      rawPreview: preview(trimmed),
      canonicalKey,
    });
    return;
  }

  acc.seenKeys.set(canonicalKey, { line: lineNumber, contentSha });
  acc.stats.valid += 1;
  acc.stats.body_records += 1;
  acc.stats.record_types[recordType] =
    (acc.stats.record_types[recordType] ?? 0) + 1;
  const record: MasterDataCanonicalRecord = {
    ...parsed,
    _canonical_key: canonicalKey,
    _source_line: lineNumber,
    _content_sha256: contentSha,
  };
  if (!acc.omitRecords) {
    acc.records.push(record);
  }
  onBodyRecord?.(record);
}

function finalize(
  acc: Acc,
  sourceFileName: string,
  sourceBytes: number,
): MasterDataCanonicalResult {
  return {
    sourceFileName,
    sourceBytes,
    stats: acc.stats,
    issues: acc.issues,
    headers: acc.headers,
    records: acc.records,
    observed_export_type: acc.observed_export_type,
    observed_system_id: acc.observed_system_id,
    observed_schema_version: acc.observed_schema_version,
    observed_table_name: acc.observed_table_name,
    observed_profile: acc.observed_profile,
  };
}

/** In-memory canonicalize (full text). */
export function canonicalizeMasterDataExport(params: {
  text: string;
  sourceFileName: string;
  sourceBytes: number;
  options?: MasterDataCanonicalOptions;
}): MasterDataCanonicalResult {
  const acc = createAcc(false, params.options?.contentKeyFields ?? []);
  const lines = params.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    ingestLine(acc, i + 1, lines[i]!);
  }
  return finalize(acc, params.sourceFileName, params.sourceBytes);
}

/** Streaming validate/canonicalize from absolute path (readline). */
export async function streamCanonicalizeMasterDataFile(params: {
  absolutePath: string;
  sourceFileName: string;
  sourceBytes: number;
  omitRecords?: boolean;
  options?: MasterDataCanonicalOptions;
}): Promise<MasterDataCanonicalResult> {
  const acc = createAcc(
    Boolean(params.omitRecords),
    params.options?.contentKeyFields ?? [],
  );
  const rl = createInterface({
    input: createReadStream(params.absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  try {
    for await (const line of rl) {
      lineNumber += 1;
      ingestLine(acc, lineNumber, line);
    }
  } finally {
    rl.close();
  }
  return finalize(acc, params.sourceFileName, params.sourceBytes);
}

/**
 * Stream-canonicalize and append body records as JSONL to `writeLine`.
 * Keeps at most one record in memory at a time (plus key set).
 */
export async function streamCanonicalizeMasterDataFileWriting(params: {
  absolutePath: string;
  sourceFileName: string;
  sourceBytes: number;
  writeLine: (line: string) => void;
  options?: MasterDataCanonicalOptions;
  /** Optional enricher (e.g. Z-/append markers) — must not invent PII. */
  enrichRecord?: (
    record: MasterDataCanonicalRecord,
  ) => MasterDataCanonicalRecord;
}): Promise<MasterDataCanonicalResult> {
  const acc = createAcc(true, params.options?.contentKeyFields ?? []);
  const rl = createInterface({
    input: createReadStream(params.absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  try {
    for await (const line of rl) {
      lineNumber += 1;
      ingestLine(acc, lineNumber, line, (record) => {
        const enriched = params.enrichRecord
          ? params.enrichRecord(record)
          : record;
        params.writeLine(
          JSON.stringify({
            ...enriched,
            _source_file: params.sourceFileName,
          }),
        );
      });
    }
  } finally {
    rl.close();
  }
  return finalize(acc, params.sourceFileName, params.sourceBytes);
}

export function masterDataValidationOk(
  result: MasterDataCanonicalResult,
): boolean {
  return (
    result.stats.invalid === 0 &&
    result.stats.key_collisions === 0 &&
    result.stats.headers >= 1 &&
    result.stats.body_records >= 1
  );
}

/** Mark Z-/Y- and append-include fields; preserve included_in_content link. */
export function enrichMasterStructureRecord(
  record: MasterDataCanonicalRecord,
): MasterDataCanonicalRecord {
  const fieldName =
    typeof record.field_name === "string" ? record.field_name : "";
  const isAppendInclude = fieldName.startsWith(".INCLU");
  const isZField =
    fieldName.startsWith("Z") ||
    fieldName.startsWith("Y") ||
    fieldName.startsWith("ZZ");
  return {
    ...record,
    _is_z_field: isZField,
    _is_append_include: isAppendInclude,
    _linked_to_content: record.included_in_content === true,
  };
}
