/**
 * Deterministic Materialstammdaten RAW → canonical.
 *
 * Evidence (P01 raw/master-data/materials, 2026-08-04):
 * - Header export_type: MASTER_CONTENT | MASTER_STRUCTURE
 * - Header/body table_name: MARA | MARC | MARD | MVKE | MARM
 * - Body CONTENT: record_type=master_data_row + values{} (+ row_number)
 * - Body STRUCTURE: record_type=master_field_definition + field_name
 */

import { createHash } from "crypto";
import { createReadStream } from "fs";
import { createInterface } from "readline";

export type MaterialsCanonicalStats = {
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

export type MaterialsLineIssue = {
  lineNumber: number;
  error: string;
  code?: "INVALID_JSON" | "SCHEMA" | "KEY_COLLISION" | "EMPTY";
  rawPreview: string;
  canonicalKey?: string;
};

export type MaterialsCanonicalRecord = Record<string, unknown> & {
  _canonical_key: string;
  _source_line: number;
  _content_sha256: string;
};

export type MaterialsCanonicalResult = {
  sourceFileName: string;
  sourceBytes: number;
  stats: MaterialsCanonicalStats;
  issues: MaterialsLineIssue[];
  headers: Record<string, unknown>[];
  records: MaterialsCanonicalRecord[];
  /** Observed export_type from first valid header — not a pinned rule. */
  observed_export_type: string | null;
  observed_system_id: string | null;
  observed_schema_version: string | null;
  observed_table_name: string | null;
};

type Acc = {
  stats: MaterialsCanonicalStats;
  issues: MaterialsLineIssue[];
  headers: Record<string, unknown>[];
  records: MaterialsCanonicalRecord[];
  seenKeys: Map<string, { line: number; contentSha: string }>;
  observed_export_type: string | null;
  observed_system_id: string | null;
  observed_schema_version: string | null;
  observed_table_name: string | null;
  /** When true, body rows are counted/validated but not kept in `records`. */
  omitRecords: boolean;
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
 * Prefers table_name + row_number / field_name / values.MATNR(+siblings) / top-level ids.
 */
function deriveCanonicalKey(
  obj: Record<string, unknown>,
  contentSha: string,
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
    // Key parts observed on CONTENT values across MARA/MARC/MARD/MVKE/MARM samples.
    const parts: string[] = [];
    for (const k of ["MATNR", "WERKS", "LGORT", "VKORG", "VTWEG", "MEINH"]) {
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
    "matnr",
    "MATNR",
    "material",
    "material_number",
    "object_key",
    "row_key",
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

function validateBodyShape(obj: Record<string, unknown>): string | null {
  if (!asNonEmptyString(obj.record_type)) {
    return "record_type fehlt oder ist leer";
  }
  if (asNonEmptyString(obj.record_type) === "header") {
    return null;
  }
  // Minimal shared fields only when present on sibling SAP JSONL exports —
  // do not invent MARA column requirements.
  return null;
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

function createAcc(omitRecords = false): Acc {
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
    omitRecords,
  };
}

function ingestLine(
  acc: Acc,
  lineNumber: number,
  line: string,
  onBodyRecord?: (record: MaterialsCanonicalRecord) => void,
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
    }
    return;
  }

  const bodyErr = validateBodyShape(parsed);
  if (bodyErr) {
    acc.stats.invalid += 1;
    acc.issues.push({
      lineNumber,
      error: bodyErr,
      code: "SCHEMA",
      rawPreview: preview(trimmed),
    });
    return;
  }

  const contentSha = sha256Hex(trimmed);
  const canonicalKey = deriveCanonicalKey(parsed, contentSha);
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
  const record: MaterialsCanonicalRecord = {
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
): MaterialsCanonicalResult {
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
  };
}

/** In-memory canonicalize (full text). */
export function canonicalizeMaterialsExport(params: {
  text: string;
  sourceFileName: string;
  sourceBytes: number;
}): MaterialsCanonicalResult {
  const acc = createAcc();
  const lines = params.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    ingestLine(acc, i + 1, lines[i]!);
  }
  return finalize(acc, params.sourceFileName, params.sourceBytes);
}

/** Streaming validate/canonicalize from absolute path (readline). */
export async function streamCanonicalizeMaterialsFile(params: {
  absolutePath: string;
  sourceFileName: string;
  sourceBytes: number;
  /** Stats-only mode for large CONTENT files (no records array). */
  omitRecords?: boolean;
}): Promise<MaterialsCanonicalResult> {
  const acc = createAcc(Boolean(params.omitRecords));
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
export async function streamCanonicalizeMaterialsFileWriting(params: {
  absolutePath: string;
  sourceFileName: string;
  sourceBytes: number;
  writeLine: (line: string) => void;
}): Promise<MaterialsCanonicalResult> {
  const acc = createAcc(true);
  const rl = createInterface({
    input: createReadStream(params.absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  try {
    for await (const line of rl) {
      lineNumber += 1;
      ingestLine(acc, lineNumber, line, (record) => {
        params.writeLine(
          JSON.stringify({
            ...record,
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

export function materialsRecordsToJsonl(
  records: MaterialsCanonicalRecord[],
): string {
  if (records.length === 0) return "";
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

export function materialsValidationOk(
  result: MaterialsCanonicalResult,
): boolean {
  return (
    result.stats.invalid === 0 &&
    result.stats.key_collisions === 0 &&
    result.stats.headers >= 1 &&
    result.stats.body_records >= 1
  );
}
