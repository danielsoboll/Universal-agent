/**
 * Streaming JSONL validation + per-(config_group × source_table) schema profiling.
 */

import { createHash } from "crypto";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import {
  EXPECTED_EXPORT_TYPE,
  EXPECTED_SOURCE_TABLES,
  isConfigGroup,
  type MessageIdocConfigGroup,
  type MessageIdocFileFormalStatus,
} from "@/lib/admin/datenbasis/messageIdocConfig/constants";
import { parseMissingTableNames } from "@/lib/admin/datenbasis/messageIdocConfig/detectRaw";
import type {
  DeclaredFieldInfo,
  DetectedMessageIdocFile,
  FieldProfile,
  InvalidRowReport,
  JsonScalarType,
  MessageIdocHeaderInfo,
  TableSchemaProfile,
} from "@/lib/admin/datenbasis/messageIdocConfig/types";

const MAX_SAMPLE_VALUES = 5;
const MAX_DISTINCT_TRACK = 200;
const MAX_INVALID_SAMPLES = 25;
const MAX_TECH_NAMES = 40;

const META_FIELD_KEYS = new Set([
  "schema_version",
  "record_type",
  "system_id",
  "client",
  "export_type",
  "config_group",
  "source_table",
  "table_name",
  "tables_found",
  "tables_missing",
  "rows_exported",
  "missing_table_names",
  "movement_data_included",
  "object_selection_applied",
  "values",
  "primary_key",
  "row_number",
  "description",
  "field_count",
  "client_dependent",
  "field_name",
  "position",
  "key",
  "data_element",
  "domain",
  "data_type",
  "length",
  "decimals",
  "included_in_rows",
]);

/** Known SAP export record types for this pipeline. */
export const MESSAGE_IDOC_RECORD_TYPES = [
  "header",
  "config_table_definition",
  "config_field_definition",
  "configuration_row",
] as const;

function classifyValue(v: unknown): JsonScalarType {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return v === "" ? "empty_string" : "string";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "string";
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

export function looksLikeTechnicalObjectName(value: string): boolean {
  const t = value.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (/\s/.test(t)) return false;
  if (!/^[A-Za-z\/][A-Za-z0-9_\/.\-]*$/.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) return false;
  const upperRatio =
    letters.replace(/[^A-Z]/g, "").length / Math.max(1, letters.length);
  return upperRatio >= 0.5 || /^[ZzYy]/.test(t) || t.includes("/");
}

function fieldNameSuggestsKey(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /(^|_)(id|key|nr|num|name|code|type|guid)(_|$)/i.test(n) ||
    n.endsWith("id") ||
    n.endsWith("key") ||
    n.endsWith("nr")
  );
}

function fieldNameSuggestsTechnical(name: string): boolean {
  const n = name.toLowerCase();
  return /(object|program|function|modul|msgtyp|idoctyp|mestyp|partner|port|process|routine|segment|extension|logsys)/i.test(
    n,
  );
}

type FieldAcc = {
  types: Set<JsonScalarType>;
  nullOrEmpty: number;
  nonEmpty: number;
  samples: unknown[];
  distinct: Set<string>;
  techNames: Set<string>;
};

function ensureField(map: Map<string, FieldAcc>, name: string): FieldAcc {
  let acc = map.get(name);
  if (!acc) {
    acc = {
      types: new Set(),
      nullOrEmpty: 0,
      nonEmpty: 0,
      samples: [],
      distinct: new Set(),
      techNames: new Set(),
    };
    map.set(name, acc);
  }
  return acc;
}

function observeValue(acc: FieldAcc, fieldName: string, value: unknown): void {
  const t = classifyValue(value);
  acc.types.add(t);
  if (isEmptyValue(value)) {
    acc.nullOrEmpty += 1;
    return;
  }
  acc.nonEmpty += 1;
  if (acc.samples.length < MAX_SAMPLE_VALUES) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      acc.samples.push(value);
    } else {
      acc.samples.push(`[${t}]`);
    }
  }
  const distKey =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value).slice(0, 120);
  if (acc.distinct.size < MAX_DISTINCT_TRACK) acc.distinct.add(distKey);
  if (
    typeof value === "string" &&
    (fieldNameSuggestsTechnical(fieldName) ||
      looksLikeTechnicalObjectName(value)) &&
    looksLikeTechnicalObjectName(value) &&
    acc.techNames.size < MAX_TECH_NAMES
  ) {
    acc.techNames.add(value.trim());
  }
}

function buildFieldProfiles(
  map: Map<string, FieldAcc>,
  validRows: number,
): {
  fields: FieldProfile[];
  possibleKeyColumns: string[];
  possibleTechnicalObjectNames: string[];
} {
  const fields: FieldProfile[] = [];
  const possibleKeyColumns: string[] = [];
  const techAll = new Set<string>();

  for (const [fieldName, acc] of [...map.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], "en"),
  )) {
    const total = acc.nullOrEmpty + acc.nonEmpty;
    const rate = total === 0 ? 1 : acc.nullOrEmpty / total;
    const uniqueness =
      acc.nonEmpty === 0 ? 0 : acc.distinct.size / Math.max(1, acc.nonEmpty);
    const possibleKey =
      fieldNameSuggestsKey(fieldName) ||
      (acc.nonEmpty >= 3 && uniqueness >= 0.85 && validRows >= 3);
    if (possibleKey) possibleKeyColumns.push(fieldName);
    for (const n of acc.techNames) techAll.add(n);
    fields.push({
      fieldName,
      observedTypes: [...acc.types].sort(),
      nullOrEmptyCount: acc.nullOrEmpty,
      nonEmptyCount: acc.nonEmpty,
      nullOrEmptyRate: Math.round(rate * 1000) / 1000,
      sampleValues: acc.samples,
      distinctCountSampled: acc.distinct.size,
      possibleKey,
    });
  }

  return {
    fields,
    possibleKeyColumns,
    possibleTechnicalObjectNames: [...techAll].sort().slice(0, MAX_TECH_NAMES),
  };
}

export function hashSchemaFields(
  fieldNames: string[],
  typesByField: Record<string, string[]>,
): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ fields: fieldNames, types: typesByField }));
  return h.digest("hex").slice(0, 16);
}

export function schemaProfileKey(
  configGroup: string,
  sourceTable: string,
): string {
  return `${configGroup}__${sourceTable}`;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "x" || t === "1") return true;
    if (t === "false" || t === "" || t === "0" || t === "-") return false;
  }
  return null;
}

function extractSourceTable(obj: Record<string, unknown>): string | null {
  for (const key of ["source_table", "table_name"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim().toUpperCase();
  }
  return null;
}

/** Field values for profiling: prefer nested `values`, else non-meta top-level. */
function extractValueFields(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const nested = obj.values;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (META_FIELD_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function formalStatusLabel(
  status: MessageIdocFileFormalStatus,
): string {
  switch (status) {
    case "ok":
      return "ok";
    case "keine_unterstuetzten_quelltabellen":
      return "keine unterstützten Quelltabellen im System";
    case "header_invalid":
      return "Header ungültig";
    case "empty":
      return "leere Datei";
    case "validation_errors":
      return "Validierungsfehler";
  }
}

export function validateHeaderObject(
  header: Record<string, unknown>,
  fileNameGroup: MessageIdocConfigGroup | null,
): {
  info: MessageIdocHeaderInfo;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  const exportType =
    typeof header.export_type === "string" ? header.export_type.trim() : null;
  const configGroupRaw =
    typeof header.config_group === "string" ? header.config_group.trim() : null;
  const movement = asBool(header.movement_data_included);
  const objectSel = asBool(header.object_selection_applied);
  const missingNames = parseMissingTableNames(header.missing_table_names);
  const tablesFound = asNumber(header.tables_found);
  const tablesMissing = asNumber(header.tables_missing);
  const rowsExported = asNumber(header.rows_exported);

  if (exportType !== EXPECTED_EXPORT_TYPE) {
    errors.push(
      `export_type muss ${EXPECTED_EXPORT_TYPE} sein (ist: ${exportType ?? "fehlend"})`,
    );
  }

  let configGroup: MessageIdocConfigGroup | string | null = configGroupRaw;
  if (!configGroupRaw) {
    errors.push("config_group fehlt im Header");
  } else if (!isConfigGroup(configGroupRaw)) {
    errors.push(`unbekannte config_group: ${configGroupRaw}`);
  } else {
    configGroup = configGroupRaw;
    if (fileNameGroup && fileNameGroup !== configGroupRaw) {
      errors.push(
        `config_group im Header (${configGroupRaw}) weicht vom Dateinamen (${fileNameGroup}) ab`,
      );
    }
  }

  if (movement === null) {
    errors.push("movement_data_included fehlt oder ist ungültig");
  } else if (movement !== false) {
    errors.push("movement_data_included muss false sein");
  }

  if (objectSel === null) {
    errors.push("object_selection_applied fehlt oder ist ungültig");
  } else if (objectSel !== false) {
    errors.push("object_selection_applied muss false sein (S_OBJ nicht verwendet)");
  }

  if (tablesMissing != null && tablesMissing > 0) {
    warnings.push(
      `${tablesMissing} Quelltabelle(n) fehlen im System (kein Validierungsfehler): ${missingNames.join(", ") || "—"}`,
    );
  }

  if (
    isConfigGroup(configGroupRaw ?? "") &&
    tablesFound === 0 &&
    (tablesMissing ?? 0) > 0
  ) {
    warnings.push(
      "Keine unterstützten Quelltabellen im System für diese Gruppe",
    );
  }

  const info: MessageIdocHeaderInfo = {
    schema_version:
      typeof header.schema_version === "string"
        ? header.schema_version
        : header.schema_version != null
          ? String(header.schema_version)
          : null,
    system_id:
      typeof header.system_id === "string" ? header.system_id : null,
    client: typeof header.client === "string" ? header.client : null,
    export_type: exportType,
    config_group: configGroup,
    tables_found: tablesFound,
    tables_missing: tablesMissing,
    rows_exported: rowsExported,
    missing_table_names: missingNames,
    movement_data_included: movement,
    object_selection_applied: objectSel,
  };

  return { info, errors, warnings };
}

export type FileValidateProfileResult = {
  header: MessageIdocHeaderInfo | null;
  headerCount: number;
  duplicateHeader: boolean;
  headerErrors: string[];
  warnings: string[];
  formalStatus: MessageIdocFileFormalStatus;
  lineCount: number;
  emptyLines: number;
  validRows: number;
  invalidRows: number;
  /** configuration_row counts (matches header rows_exported). */
  rowsRead: number;
  rowsBySourceTable: Record<string, number>;
  recordTypeCounts: Record<string, number>;
  tableProfiles: TableSchemaProfile[];
  invalidSamples: InvalidRowReport[];
  sourceHash: string;
};

type TableMetaAcc = {
  definition: {
    description: string | null;
    field_count: number | null;
    client_dependent: boolean | null;
  } | null;
  declaredFields: DeclaredFieldInfo[];
};

/**
 * Stream one JSONL: validate header + rows, profile configuration_row per source_table.
 */
export async function validateAndProfileJsonlFile(
  absolutePath: string,
  meta: DetectedMessageIdocFile,
): Promise<FileValidateProfileResult> {
  const invalidSamples: InvalidRowReport[] = [];
  const warnings: string[] = [];
  let headerCount = 0;
  let header: MessageIdocHeaderInfo | null = null;
  let headerErrors: string[] = [];
  let lineCount = 0;
  let emptyLines = 0;
  let validRows = 0;
  let invalidRows = 0;
  let rowsRead = 0;
  const rowsBySourceTable: Record<string, number> = {};
  const recordTypeCounts: Record<string, number> = {};
  /** source_table → field accumulators from configuration_row.values */
  const tableMaps = new Map<string, Map<string, FieldAcc>>();
  const tableMeta = new Map<string, TableMetaAcc>();
  const contentHash = createHash("sha256");

  function ensureTableMeta(sourceTable: string): TableMetaAcc {
    let m = tableMeta.get(sourceTable);
    if (!m) {
      m = { definition: null, declaredFields: [] };
      tableMeta.set(sourceTable, m);
    }
    return m;
  }

  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      lineCount += 1;
      const trimmed = line.trim();
      if (!trimmed) {
        emptyLines += 1;
        continue;
      }
      contentHash.update(trimmed);
      contentHash.update("\n");

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        invalidRows += 1;
        if (invalidSamples.length < MAX_INVALID_SAMPLES) {
          invalidSamples.push({
            fileName: meta.fileName,
            lineNumber: lineCount,
            message: e instanceof Error ? e.message : "JSON parse error",
          });
        }
        continue;
      }

      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        invalidRows += 1;
        if (invalidSamples.length < MAX_INVALID_SAMPLES) {
          invalidSamples.push({
            fileName: meta.fileName,
            lineNumber: lineCount,
            message: "Zeile ist kein JSON-Objekt",
          });
        }
        continue;
      }

      const obj = parsed as Record<string, unknown>;
      const recordType =
        typeof obj.record_type === "string"
          ? obj.record_type.trim().toLowerCase()
          : "";

      if (!recordType) {
        invalidRows += 1;
        if (invalidSamples.length < MAX_INVALID_SAMPLES) {
          invalidSamples.push({
            fileName: meta.fileName,
            lineNumber: lineCount,
            message: "record_type fehlt",
          });
        }
        continue;
      }

      recordTypeCounts[recordType] = (recordTypeCounts[recordType] ?? 0) + 1;

      if (recordType === "header") {
        headerCount += 1;
        if (headerCount === 1) {
          const checked = validateHeaderObject(
            obj,
            meta.configGroupFromFileName,
          );
          header = checked.info;
          headerErrors = checked.errors;
          warnings.push(...checked.warnings);
          validRows += 1;
        } else {
          invalidRows += 1;
          if (invalidSamples.length < MAX_INVALID_SAMPLES) {
            invalidSamples.push({
              fileName: meta.fileName,
              lineNumber: lineCount,
              message: "Doppelter Header",
              config_group: header?.config_group ?? null,
            });
          }
        }
        continue;
      }

      const sourceTable = extractSourceTable(obj);
      if (!sourceTable) {
        invalidRows += 1;
        if (invalidSamples.length < MAX_INVALID_SAMPLES) {
          invalidSamples.push({
            fileName: meta.fileName,
            lineNumber: lineCount,
            message: `source_table fehlt (record_type=${recordType})`,
            config_group:
              (typeof obj.config_group === "string"
                ? obj.config_group
                : header?.config_group) ?? null,
          });
        }
        continue;
      }

      if (recordType === "config_table_definition") {
        const m = ensureTableMeta(sourceTable);
        m.definition = {
          description:
            typeof obj.description === "string" ? obj.description : null,
          field_count: asNumber(obj.field_count),
          client_dependent: asBool(obj.client_dependent),
        };
        validRows += 1;
        continue;
      }

      if (recordType === "config_field_definition") {
        const m = ensureTableMeta(sourceTable);
        const fieldName =
          typeof obj.field_name === "string" ? obj.field_name.trim() : "";
        if (!fieldName) {
          invalidRows += 1;
          if (invalidSamples.length < MAX_INVALID_SAMPLES) {
            invalidSamples.push({
              fileName: meta.fileName,
              lineNumber: lineCount,
              message: "config_field_definition ohne field_name",
              source_table: sourceTable,
            });
          }
          continue;
        }
        m.declaredFields.push({
          field_name: fieldName,
          position: asNumber(obj.position),
          key: asBool(obj.key),
          data_element:
            typeof obj.data_element === "string" ? obj.data_element : null,
          data_type: typeof obj.data_type === "string" ? obj.data_type : null,
          length: asNumber(obj.length),
          description:
            typeof obj.description === "string" ? obj.description : null,
          included_in_rows: asBool(obj.included_in_rows),
        });
        validRows += 1;
        continue;
      }

      if (recordType === "configuration_row") {
        rowsRead += 1;
        rowsBySourceTable[sourceTable] =
          (rowsBySourceTable[sourceTable] ?? 0) + 1;
        ensureTableMeta(sourceTable);
        if (!tableMaps.has(sourceTable)) {
          tableMaps.set(sourceTable, new Map());
        }
        const fieldMap = tableMaps.get(sourceTable)!;
        const values = extractValueFields(obj);
        if (Object.keys(values).length === 0) {
          warnings.push(
            `configuration_row ohne values (Zeile ${lineCount}, ${sourceTable})`,
          );
        }
        for (const [k, v] of Object.entries(values)) {
          observeValue(ensureField(fieldMap, k), k, v);
        }
        validRows += 1;
        continue;
      }

      // Unknown record type — tolerate but warn once pattern
      warnings.push(
        `Unbekannter record_type "${recordType}" (Zeile ${lineCount}) — akzeptiert`,
      );
      validRows += 1;
    }
  } finally {
    rl.close();
  }

  // Dedupe repetitive unknown-type warnings
  const uniqWarnings = [...new Set(warnings)];

  const duplicateHeader = headerCount > 1;
  if (headerCount === 0 && lineCount - emptyLines > 0) {
    headerErrors = [
      ...headerErrors,
      "Kein Header (record_type=header) gefunden",
    ];
  }

  const configGroupForProfiles =
    (header?.config_group && isConfigGroup(String(header.config_group))
      ? (header.config_group as MessageIdocConfigGroup)
      : null) ??
    meta.configGroupFromFileName ??
    "UNKNOWN_GROUP";

  const allTables = new Set([
    ...tableMaps.keys(),
    ...tableMeta.keys(),
    ...Object.keys(rowsBySourceTable),
  ]);

  const tableProfiles: TableSchemaProfile[] = [];
  for (const sourceTable of [...allTables].sort((a, b) =>
    a.localeCompare(b, "en"),
  )) {
    const fieldMap = tableMaps.get(sourceTable) ?? new Map();
    const rowCount = rowsBySourceTable[sourceTable] ?? 0;
    const metaAcc = tableMeta.get(sourceTable);
    const { fields, possibleKeyColumns, possibleTechnicalObjectNames } =
      buildFieldProfiles(fieldMap, rowCount);
    const detectedFieldNames = fields.map((f) => f.fieldName);
    const typesByField: Record<string, string[]> = {};
    for (const f of fields) typesByField[f.fieldName] = f.observedTypes;

    const expected = isConfigGroup(String(configGroupForProfiles))
      ? EXPECTED_SOURCE_TABLES[configGroupForProfiles as MessageIdocConfigGroup]
      : [];
    const notes: string[] = [
      "Profil aus configuration_row.values je config_group × source_table.",
      "declared_fields aus config_field_definition (SAP-Struktur).",
    ];
    if (expected.length > 0 && !expected.includes(sourceTable)) {
      notes.push(
        `source_table ${sourceTable} war nicht in der erwarteten Tabellenliste dieser Gruppe (trotzdem profiliert).`,
      );
    }
    if (rowCount === 0 && (metaAcc?.declaredFields.length ?? 0) > 0) {
      notes.push(
        "Nur Strukturdefinitionen, keine configuration_row-Daten für diese Tabelle.",
      );
    }

    // Prefer declared key fields when present
    const declaredKeys = (metaAcc?.declaredFields ?? [])
      .filter((d) => d.key === true)
      .map((d) => d.field_name);
    const keyCols = [
      ...new Set([...declaredKeys, ...possibleKeyColumns]),
    ].sort();

    tableProfiles.push({
      config_group: configGroupForProfiles,
      source_table: sourceTable,
      fileName: meta.fileName,
      relativePath: meta.relativePath,
      rowCount,
      table_definition: metaAcc?.definition ?? null,
      declared_fields: metaAcc?.declaredFields ?? [],
      fields,
      detectedFieldNames,
      possibleKeyColumns: keyCols,
      possibleTechnicalObjectNames,
      schemaHash: hashSchemaFields(detectedFieldNames, typesByField),
      profiledAt: new Date().toISOString(),
      notes,
    });
  }

  if (
    header?.rows_exported != null &&
    header.rows_exported !== rowsRead
  ) {
    uniqWarnings.push(
      `rows_exported im Header (${header.rows_exported}) ≠ configuration_row gelesen (${rowsRead})`,
    );
  }

  let formalStatus: MessageIdocFileFormalStatus;
  if (meta.bytes === 0 || lineCount === 0 || lineCount === emptyLines) {
    formalStatus = "empty";
  } else if (headerErrors.length > 0 || headerCount === 0) {
    formalStatus = "header_invalid";
  } else if (
    header &&
    (header.tables_found === 0 ||
      (rowsRead === 0 &&
        (header.tables_missing ?? 0) > 0 &&
        Object.keys(rowsBySourceTable).length === 0))
  ) {
    formalStatus = "keine_unterstuetzten_quelltabellen";
  } else if (invalidRows > 0) {
    formalStatus = "validation_errors";
  } else {
    formalStatus = "ok";
  }

  return {
    header,
    headerCount,
    duplicateHeader,
    headerErrors,
    warnings: uniqWarnings,
    formalStatus,
    lineCount,
    emptyLines,
    validRows,
    invalidRows,
    rowsRead,
    rowsBySourceTable,
    recordTypeCounts,
    tableProfiles,
    invalidSamples,
    sourceHash: contentHash.digest("hex").slice(0, 16),
  };
}
