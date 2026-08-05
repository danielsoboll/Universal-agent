import { createHash } from "crypto";

export const SAP_CLASS_RECORD_TYPES = [
  "header",
  "source_object",
  "source_fragment",
  "code_unit",
  "relation",
] as const;

export type SapClassRecordType = (typeof SAP_CLASS_RECORD_TYPES)[number];

export type SapClassCanonicalStats = {
  lines_total: number;
  valid: number;
  invalid: number;
  classes: number;
  methods: number;
  fragments: number;
  relations: number;
  duplicates: number;
  key_collisions: number;
};

export type SapClassLineIssue = {
  lineNumber: number;
  error: string;
  code?: "KEY_COLLISION" | "INVALID_JSON" | "SCHEMA";
  rawPreview: string;
  canonicalKey?: string;
};

export type SapClassCanonicalResult = {
  sourceFileName: string;
  sourceBytes: number;
  stats: SapClassCanonicalStats;
  issues: SapClassLineIssue[];
  sourceObjects: Record<string, unknown>[];
  sourceFragments: Record<string, unknown>[];
  codeUnits: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  headers: Record<string, unknown>[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  return asNonEmptyString(obj[key]);
}

function isRecordType(value: unknown): value is SapClassRecordType {
  return (
    typeof value === "string" &&
    (SAP_CLASS_RECORD_TYPES as readonly string[]).includes(value)
  );
}

function validateRecord(
  recordType: SapClassRecordType,
  obj: Record<string, unknown>,
): string | null {
  if (!requireString(obj, "schema_version")) {
    return "schema_version fehlt oder ist leer";
  }
  if (!requireString(obj, "system_id")) {
    return "system_id fehlt oder ist leer";
  }

  switch (recordType) {
    case "header":
      if (!requireString(obj, "export_type")) {
        return "header: export_type fehlt";
      }
      return null;
    case "source_object":
      if (!requireString(obj, "source_key")) return "source_object: source_key fehlt";
      if (!requireString(obj, "object_type")) return "source_object: object_type fehlt";
      if (!requireString(obj, "object_name")) return "source_object: object_name fehlt";
      return null;
    case "source_fragment":
      if (!requireString(obj, "object_type")) return "source_fragment: object_type fehlt";
      if (!requireString(obj, "object_name")) return "source_fragment: object_name fehlt";
      if (!requireString(obj, "include_name")) {
        return "source_fragment: include_name fehlt";
      }
      if (
        !requireString(obj, "fragment_type") &&
        !requireString(obj, "unit_type")
      ) {
        return "source_fragment: fragment_type/unit_type fehlt";
      }
      if (typeof obj.source_code !== "string") {
        return "source_fragment: source_code fehlt";
      }
      return null;
    case "code_unit":
      if (!requireString(obj, "source_key")) return "code_unit: source_key fehlt";
      if (!requireString(obj, "object_type")) return "code_unit: object_type fehlt";
      if (!requireString(obj, "object_name")) return "code_unit: object_name fehlt";
      if (!requireString(obj, "unit_type")) return "code_unit: unit_type fehlt";
      if (typeof obj.source_code !== "string") {
        return "code_unit: source_code fehlt";
      }
      return null;
    case "relation":
      if (!requireString(obj, "from_type")) return "relation: from_type fehlt";
      if (!requireString(obj, "from_name")) return "relation: from_name fehlt";
      if (!requireString(obj, "relation_type")) {
        return "relation: relation_type fehlt";
      }
      if (!requireString(obj, "to_type")) return "relation: to_type fehlt";
      if (!requireString(obj, "to_name")) return "relation: to_name fehlt";
      return null;
    default:
      return `Unbekannter record_type: ${recordType}`;
  }
}

/**
 * Canonical identity key for deduplication / collision detection.
 * source_fragment: system_id|object_type|object_name|SOURCE_FRAGMENT|include_name
 * code_unit: code_unit|{source_key}|{include_name} when include_name present
 */
export function canonicalKeyForRecord(
  recordType: SapClassRecordType,
  obj: Record<string, unknown>,
): string {
  if (recordType === "header") {
    return [
      "header",
      obj.system_id,
      obj.export_type,
      obj.schema_version,
    ].join("|");
  }

  if (recordType === "source_fragment") {
    return [
      String(obj.system_id),
      String(obj.object_type),
      String(obj.object_name),
      "SOURCE_FRAGMENT",
      String(obj.include_name),
    ].join("|");
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

  // code_unit / source_object: source_key is primary, but schema 2.8 full
  // exports can repeat the same source_key across different includes
  // (e.g. CONSTRUCTOR bodies mis-keyed under a related class name).
  // Disambiguate with include_name when present — same pattern as source_fragment.
  if (recordType === "code_unit") {
    const sourceKey = asNonEmptyString(obj.source_key);
    const includeName = asNonEmptyString(obj.include_name);
    if (sourceKey && includeName) {
      return `code_unit|${sourceKey}|${includeName}`;
    }
    if (sourceKey) {
      return `code_unit|${sourceKey}`;
    }
    return `code_unit|${createHash("sha256")
      .update(JSON.stringify(obj))
      .digest("hex")}`;
  }

  const sourceKey = asNonEmptyString(obj.source_key);
  if (sourceKey) {
    return `${recordType}|${sourceKey}`;
  }
  return `${recordType}|${createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex")}`;
}

/** @deprecated Use canonicalKeyForRecord */
export const dedupeKeyForRecord = canonicalKeyForRecord;

export function contentHashForRecord(
  recordType: SapClassRecordType,
  obj: Record<string, unknown>,
): string {
  if (recordType === "source_fragment" || recordType === "code_unit") {
    const code = typeof obj.source_code === "string" ? obj.source_code : "";
    return createHash("sha256").update(code, "utf8").digest("hex");
  }
  return createHash("sha256")
    .update(JSON.stringify(obj), "utf8")
    .digest("hex");
}

/**
 * Convert SAP class export JSONL into separated, deduplicated canonical records.
 * No I/O, no OpenAI, no Supabase.
 *
 * Dedup rules:
 * 1. same canonical key + same content hash → true duplicate (keep first)
 * 2. same canonical key + different content hash → KEY_COLLISION (never silent drop)
 * 3. different canonical key → keep both
 */
export function canonicalizeSapClassExport(params: {
  text: string;
  sourceFileName: string;
  sourceBytes: number;
}): SapClassCanonicalResult {
  const normalized = params.text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);

  const issues: SapClassLineIssue[] = [];
  const headers: Record<string, unknown>[] = [];
  const sourceObjects: Record<string, unknown>[] = [];
  const sourceFragments: Record<string, unknown>[] = [];
  const codeUnits: Record<string, unknown>[] = [];
  const relations: Record<string, unknown>[] = [];

  const seen = new Map<string, { contentHash: string; lineNumber: number }>();
  let valid = 0;
  let invalid = 0;
  let duplicates = 0;
  let keyCollisions = 0;
  let contentLines = 0;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const lineNumber = index + 1;
    if (raw.trim() === "") continue;
    contentLines += 1;

    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      invalid += 1;
      issues.push({
        lineNumber,
        code: "INVALID_JSON",
        error: error instanceof Error ? error.message : "JSON ungültig",
        rawPreview: raw.slice(0, 200),
      });
      continue;
    }

    if (!isPlainObject(value)) {
      invalid += 1;
      issues.push({
        lineNumber,
        code: "SCHEMA",
        error: "Zeile ist kein JSON-Objekt",
        rawPreview: raw.slice(0, 200),
      });
      continue;
    }

    if (!isRecordType(value.record_type)) {
      invalid += 1;
      issues.push({
        lineNumber,
        code: "SCHEMA",
        error: `Ungültiger oder fehlender record_type: ${String(value.record_type)}`,
        rawPreview: raw.slice(0, 200),
      });
      continue;
    }

    const recordType = value.record_type;
    const schemaError = validateRecord(recordType, value);
    if (schemaError) {
      invalid += 1;
      issues.push({
        lineNumber,
        code: "SCHEMA",
        error: schemaError,
        rawPreview: raw.slice(0, 200),
      });
      continue;
    }

    valid += 1;
    const key = canonicalKeyForRecord(recordType, value);
    const contentHash = contentHashForRecord(recordType, value);
    const previous = seen.get(key);

    if (previous) {
      if (previous.contentHash === contentHash) {
        duplicates += 1;
        continue;
      }
      keyCollisions += 1;
      issues.push({
        lineNumber,
        code: "KEY_COLLISION",
        canonicalKey: key,
        error: `KEY_COLLISION: kanonischer Schlüssel kollidiert mit unterschiedlichem Inhalt (erste Zeile ${previous.lineNumber}). Schlüssel: ${key}`,
        rawPreview: raw.slice(0, 200),
      });
      continue;
    }

    seen.set(key, { contentHash, lineNumber });

    switch (recordType) {
      case "header":
        headers.push(value);
        break;
      case "source_object":
        sourceObjects.push(value);
        break;
      case "source_fragment":
        sourceFragments.push(value);
        break;
      case "code_unit":
        codeUnits.push(value);
        break;
      case "relation":
        relations.push(value);
        break;
    }
  }

  const classes = sourceObjects.filter(
    (o) => asNonEmptyString(o.object_type)?.toUpperCase() === "CLASS",
  ).length;
  const methods = codeUnits.filter(
    (o) => asNonEmptyString(o.unit_type)?.toUpperCase() === "METHOD",
  ).length;

  return {
    sourceFileName: params.sourceFileName,
    sourceBytes: params.sourceBytes,
    stats: {
      lines_total: contentLines,
      valid,
      invalid,
      classes,
      methods,
      fragments: sourceFragments.length,
      relations: relations.length,
      duplicates,
      key_collisions: keyCollisions,
    },
    issues,
    sourceObjects,
    sourceFragments,
    codeUnits,
    relations,
    headers,
  };
}

export function recordsToJsonl(records: Record<string, unknown>[]): string {
  if (records.length === 0) return "";
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}
