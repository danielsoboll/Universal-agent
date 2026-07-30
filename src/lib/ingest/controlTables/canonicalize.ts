import {
  CONTROL_TABLE_SCHEMA_VERSION,
  buildTableDefinitionSourceKey,
  buildTableRowSourceKey,
  normalizeCellValue,
  serializeCanonicalPrimaryKey,
  sha256,
  stableStringify,
  type CanonicalTableClassification,
  type CanonicalTableDefinition,
  type CanonicalTableRow,
  type ControlTableField,
  type TableEntity,
  type TableRelation,
} from "@/lib/ingest/controlTables/model";
import { inferEntityFromField } from "@/lib/ingest/controlTables/entityInfer";

export type ControlTableIngestIssue = {
  lineNumber: number;
  sourceFile: string;
  code:
    | "INVALID_JSON"
    | "SCHEMA"
    | "MISSING_DEFINITION"
    | "INCOMPLETE_KEY"
    | "DUPLICATE"
    | "ROW_KEY_COLLISION"
    | "KEY_COLLISION";
  error: string;
  source_key?: string;
  rawPreview: string;
};

export type ControlTablesCanonicalResult = {
  definitions: CanonicalTableDefinition[];
  classifications: CanonicalTableClassification[];
  rows: CanonicalTableRow[];
  entities: TableEntity[];
  relations: TableRelation[];
  stats: {
    lines_total: number;
    valid: number;
    invalid: number;
    definitions: number;
    classifications: number;
    rows: number;
    unique_tables: number;
    tables_with_rows: number;
    entities: number;
    relations: number;
    duplicates: number;
    key_collisions: number;
    missing_definitions: number;
    incomplete_keys: number;
  };
  issues: ControlTableIngestIssue[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseFields(raw: unknown): ControlTableField[] {
  if (!Array.isArray(raw)) return [];
  const fields: ControlTableField[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const field_name = asString(item.field_name);
    if (!field_name) continue;
    fields.push({
      field_name,
      position: asNumber(item.position, fields.length + 1),
      key: asBool(item.key, false),
      data_element: asString(item.data_element),
      domain: asString(item.domain),
      data_type: asString(item.data_type),
      length: asNumber(item.length, 0),
      decimals: asNumber(item.decimals, 0),
      description: asString(item.description),
    });
  }
  return fields.sort((a, b) => a.position - b.position);
}

function keyFieldsFrom(fields: ControlTableField[]): string[] {
  return fields.filter((f) => f.key).map((f) => f.field_name);
}

function stringMap(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = normalizeCellValue(v);
  }
  return out;
}

function normalizedMap(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = normalizeCellValue(v).toUpperCase();
  }
  return out;
}

type SeenEntry = { contentHash: string; lineNumber: number; sourceFile: string };

function trackSeen(
  seen: Map<string, SeenEntry>,
  sourceKey: string,
  contentHash: string,
  lineNumber: number,
  sourceFile: string,
  issues: ControlTableIngestIssue[],
  collisionCode: ControlTableIngestIssue["code"] = "KEY_COLLISION",
): "ok" | "duplicate" | "collision" {
  const prev = seen.get(sourceKey);
  if (!prev) {
    seen.set(sourceKey, { contentHash, lineNumber, sourceFile });
    return "ok";
  }
  if (prev.contentHash === contentHash) return "duplicate";
  issues.push({
    lineNumber,
    sourceFile,
    code: collisionCode,
    source_key: sourceKey,
    error: `${collisionCode}: Schlüssel kollidiert mit abweichendem Inhalt (erste Zeile ${prev.lineNumber} in ${prev.sourceFile})`,
    rawPreview: sourceKey.slice(0, 200),
  });
  return "collision";
}

function parseDefinition(
  obj: Record<string, unknown>,
  sourceFile: string,
): CanonicalTableDefinition | { error: string } {
  const system_id = asString(obj.system_id);
  const client = asString(obj.client);
  const table_name = asString(obj.table_name).toUpperCase();
  if (!system_id || !client || !table_name) {
    return { error: "table_definition: system_id/client/table_name fehlen" };
  }
  const fields = parseFields(obj.fields);
  const key_fields = keyFieldsFrom(fields);
  const maintenance_views = Array.isArray(obj.maintenance_views)
    ? obj.maintenance_views.map((v) => asString(v)).filter(Boolean)
    : [];

  const source_key = buildTableDefinitionSourceKey(system_id, client, table_name);
  const body = {
    system_id,
    client,
    table_name,
    description: asString(obj.description),
    package: asString(obj.package),
    delivery_class: asString(obj.delivery_class),
    table_category: asString(obj.table_category),
    active: asBool(obj.active, true),
    client_dependent: asBool(obj.client_dependent, false),
    maintenance_allowed: asBool(obj.maintenance_allowed, false),
    maintenance_dialog_exists: asBool(obj.maintenance_dialog_exists, false),
    maintenance_views,
    row_count: asNumber(obj.row_count, 0),
    key_fields,
    fields,
  };

  return {
    record_type: "table_definition",
    schema_version: CONTROL_TABLE_SCHEMA_VERSION,
    source_key,
    ...body,
    content_hash: sha256(stableStringify(body)),
    source_file: sourceFile,
  };
}

function parseClassification(
  obj: Record<string, unknown>,
  sourceFile: string,
): CanonicalTableClassification | { error: string } {
  const system_id = asString(obj.system_id);
  const client = asString(obj.client);
  const table_name = asString(obj.table_name).toUpperCase();
  const classification = asString(obj.classification);
  if (!system_id || !client || !table_name || !classification) {
    return {
      error: "table_classification: system_id/client/table_name/classification fehlen",
    };
  }
  const source_key = buildTableDefinitionSourceKey(system_id, client, table_name);
  const body = {
    system_id,
    client,
    table_name,
    classification,
    score: asNumber(obj.score, 0),
    reasons: Array.isArray(obj.reasons)
      ? obj.reasons.map((r) => asString(r)).filter(Boolean)
      : [],
    content_export_allowed: asBool(obj.content_export_allowed, false),
    row_count: asNumber(obj.row_count, 0),
    classification_version: asString(obj.classification_version, "1.0"),
  };
  return {
    record_type: "table_classification",
    schema_version: CONTROL_TABLE_SCHEMA_VERSION,
    source_key,
    ...body,
    content_hash: sha256(stableStringify(body)),
    source_file: sourceFile,
  };
}

function buildRowRelationsAndEntities(params: {
  row: CanonicalTableRow;
  definition: CanonicalTableDefinition | undefined;
}): { entities: TableEntity[]; relations: TableRelation[] } {
  const { row, definition } = params;
  const entities: TableEntity[] = [];
  const relations: TableRelation[] = [];

  relations.push({
    record_type: "table_relation",
    schema_version: CONTROL_TABLE_SCHEMA_VERSION,
    source_key: sha256(
      `TABLE_CONTAINS_ROW|${definition?.source_key ?? row.table_name}|${row.source_key}`,
    ).slice(0, 32),
    relation_type: "TABLE_CONTAINS_ROW",
    from_type: "TABLE",
    from_key:
      definition?.source_key ??
      buildTableDefinitionSourceKey(row.system_id, row.client, row.table_name),
    to_type: "TABLE_ROW",
    to_key: row.source_key,
    content_hash: "",
  });

  const fieldByName = new Map(
    (definition?.fields ?? []).map((f) => [f.field_name.toUpperCase(), f]),
  );
  const keySet = new Set(
    (definition?.key_fields ?? Object.keys(row.primary_key)).map((k) =>
      k.toUpperCase(),
    ),
  );

  for (const [field, value] of Object.entries(row.primary_key)) {
    if (!value) continue;
    relations.push({
      record_type: "table_relation",
      schema_version: CONTROL_TABLE_SCHEMA_VERSION,
      source_key: sha256(
        `ROW_HAS_KEY|${row.source_key}|${field}|${value}`,
      ).slice(0, 32),
      relation_type: "ROW_HAS_KEY",
      from_type: "TABLE_ROW",
      from_key: row.source_key,
      to_type: "KEY_VALUE",
      to_key: `${field}=${value}`,
      metadata: { field_name: field, value },
      content_hash: "",
    });
  }

  for (const [field, value] of Object.entries(row.values)) {
    if (!value) continue;
    const isKey = keySet.has(field.toUpperCase());
    // Keys already covered by ROW_HAS_KEY — only emit ROW_HAS_VALUE for non-keys
    if (!isKey) {
      relations.push({
        record_type: "table_relation",
        schema_version: CONTROL_TABLE_SCHEMA_VERSION,
        source_key: sha256(
          `ROW_HAS_VALUE|${row.source_key}|${field}|${value}`,
        ).slice(0, 32),
        relation_type: "ROW_HAS_VALUE",
        from_type: "TABLE_ROW",
        from_key: row.source_key,
        to_type: "FIELD_VALUE",
        to_key: `${field}=${value}`,
        metadata: { field_name: field, value },
        content_hash: "",
      });
    }

    const meta = fieldByName.get(field.toUpperCase()) ?? null;
    const inferred = inferEntityFromField({
      field: meta,
      fieldName: field,
      value,
      isKeyField: isKey,
    });
    // Skip low-confidence generic field_value noise
    if (!inferred || inferred.confidence < 0.55) continue;
    // Skip client_id entities (high volume, low signal for linking)
    if (inferred.entity_type === "client_id") continue;

    const entity_id = sha256(
      `${inferred.entity_type}|${inferred.normalized_value}|${row.table_name}|${field}`,
    ).slice(0, 24);
    const entity: TableEntity = {
      record_type: "table_entity",
      schema_version: CONTROL_TABLE_SCHEMA_VERSION,
      source_key: `${row.source_key}|ENTITY|${field}|${entity_id}`,
      entity_id,
      entity_type: inferred.entity_type,
      value: inferred.value,
      normalized_value: inferred.normalized_value,
      confidence: inferred.confidence,
      table_name: row.table_name,
      field_name: field,
      row_source_key: row.source_key,
      evidence: {
        data_element: meta?.data_element || undefined,
        domain: meta?.domain || undefined,
        data_type: meta?.data_type || undefined,
        field_description: meta?.description || undefined,
      },
      content_hash: "",
    };
    entity.content_hash = sha256(
      stableStringify({
        entity_type: entity.entity_type,
        value: entity.value,
        field_name: entity.field_name,
        row_source_key: entity.row_source_key,
      }),
    );
    entities.push(entity);

    relations.push({
      record_type: "table_relation",
      schema_version: CONTROL_TABLE_SCHEMA_VERSION,
      source_key: sha256(
        `ROW_REFERENCES_ENTITY|${row.source_key}|${entity.entity_id}`,
      ).slice(0, 32),
      relation_type: "ROW_REFERENCES_ENTITY",
      from_type: "TABLE_ROW",
      from_key: row.source_key,
      to_type: "ENTITY",
      to_key: entity.source_key,
      metadata: {
        entity_type: entity.entity_type,
        confidence: entity.confidence,
      },
      content_hash: "",
    });
  }

  return { entities, relations };
}

function buildDefinitionRelations(
  definition: CanonicalTableDefinition,
): TableRelation[] {
  const relations: TableRelation[] = [];
  for (const field of definition.fields) {
    relations.push({
      record_type: "table_relation",
      schema_version: CONTROL_TABLE_SCHEMA_VERSION,
      source_key: sha256(
        `TABLE_HAS_FIELD|${definition.source_key}|${field.field_name}`,
      ).slice(0, 32),
      relation_type: "TABLE_HAS_FIELD",
      from_type: "TABLE",
      from_key: definition.source_key,
      to_type: "FIELD",
      to_key: `${definition.table_name}.${field.field_name}`,
      metadata: {
        position: field.position,
        key: field.key,
        data_type: field.data_type,
      },
      content_hash: "",
    });
    if (field.data_element) {
      relations.push({
        record_type: "table_relation",
        schema_version: CONTROL_TABLE_SCHEMA_VERSION,
        source_key: sha256(
          `FIELD_USES_DATA_ELEMENT|${definition.table_name}|${field.field_name}|${field.data_element}`,
        ).slice(0, 32),
        relation_type: "FIELD_USES_DATA_ELEMENT",
        from_type: "FIELD",
        from_key: `${definition.table_name}.${field.field_name}`,
        to_type: "DATA_ELEMENT",
        to_key: field.data_element,
        content_hash: "",
      });
    }
    if (field.domain) {
      relations.push({
        record_type: "table_relation",
        schema_version: CONTROL_TABLE_SCHEMA_VERSION,
        source_key: sha256(
          `FIELD_USES_DOMAIN|${definition.table_name}|${field.field_name}|${field.domain}`,
        ).slice(0, 32),
        relation_type: "FIELD_USES_DOMAIN",
        from_type: "FIELD",
        from_key: `${definition.table_name}.${field.field_name}`,
        to_type: "DOMAIN",
        to_key: field.domain,
        content_hash: "",
      });
    }
  }
  for (const view of definition.maintenance_views) {
    relations.push({
      record_type: "table_relation",
      schema_version: CONTROL_TABLE_SCHEMA_VERSION,
      source_key: sha256(
        `MAINTAINED_BY_VIEW|${definition.source_key}|${view}`,
      ).slice(0, 32),
      relation_type: "MAINTAINED_BY_VIEW",
      from_type: "TABLE",
      from_key: definition.source_key,
      to_type: "MAINTENANCE_VIEW",
      to_key: view,
      content_hash: "",
    });
  }
  return relations;
}

function finalizeRelationHashes(relations: TableRelation[]): TableRelation[] {
  return relations.map((r) => ({
    ...r,
    content_hash: sha256(
      stableStringify({
        relation_type: r.relation_type,
        from_type: r.from_type,
        from_key: r.from_key,
        to_type: r.to_type,
        to_key: r.to_key,
        metadata: r.metadata ?? null,
      }),
    ),
  }));
}

type SourceInput = {
  text: string;
  sourceFile: string;
};

/**
 * Canonicalize control-table export JSONL (definitions + contents).
 * Raw text is never modified; pure transform.
 */
export function canonicalizeControlTableSources(
  sources: SourceInput[],
): ControlTablesCanonicalResult {
  const issues: ControlTableIngestIssue[] = [];
  const definitionsByKey = new Map<string, CanonicalTableDefinition>();
  const classificationsByKey = new Map<string, CanonicalTableClassification>();
  const rowsByKey = new Map<string, CanonicalTableRow>();

  const seenDef = new Map<string, SeenEntry>();
  const seenClass = new Map<string, SeenEntry>();
  const seenRow = new Map<string, SeenEntry>();

  let lines_total = 0;
  let valid = 0;
  let invalid = 0;
  let duplicates = 0;
  let key_collisions = 0;
  let incomplete_keys = 0;

  // Pending rows until definitions are known (process all first pass for defs)
  type PendingRow = {
    obj: Record<string, unknown>;
    sourceFile: string;
    lineNumber: number;
  };
  const pendingRows: PendingRow[] = [];

  for (const source of sources) {
    const lines = source.text.replace(/^\uFEFF/, "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      const lineNumber = i + 1;
      if (!raw.trim()) continue;
      lines_total += 1;

      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        invalid += 1;
        issues.push({
          lineNumber,
          sourceFile: source.sourceFile,
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
          sourceFile: source.sourceFile,
          code: "SCHEMA",
          error: "Zeile ist kein JSON-Objekt",
          rawPreview: raw.slice(0, 200),
        });
        continue;
      }

      const recordType = asString(value.record_type);
      if (recordType === "header") {
        valid += 1;
        continue;
      }

      if (recordType === "table_definition") {
        const parsed = parseDefinition(value, source.sourceFile);
        if ("error" in parsed) {
          invalid += 1;
          issues.push({
            lineNumber,
            sourceFile: source.sourceFile,
            code: "SCHEMA",
            error: parsed.error,
            rawPreview: raw.slice(0, 200),
          });
          continue;
        }
        valid += 1;
        const status = trackSeen(
          seenDef,
          parsed.source_key,
          parsed.content_hash,
          lineNumber,
          source.sourceFile,
          issues,
        );
        if (status === "duplicate") {
          duplicates += 1;
          continue;
        }
        if (status === "collision") {
          key_collisions += 1;
          continue;
        }
        definitionsByKey.set(parsed.source_key, parsed);
        continue;
      }

      if (recordType === "table_classification") {
        const parsed = parseClassification(value, source.sourceFile);
        if ("error" in parsed) {
          invalid += 1;
          issues.push({
            lineNumber,
            sourceFile: source.sourceFile,
            code: "SCHEMA",
            error: parsed.error,
            rawPreview: raw.slice(0, 200),
          });
          continue;
        }
        valid += 1;
        const status = trackSeen(
          seenClass,
          parsed.source_key,
          parsed.content_hash,
          lineNumber,
          source.sourceFile,
          issues,
        );
        if (status === "duplicate") {
          duplicates += 1;
          continue;
        }
        if (status === "collision") {
          key_collisions += 1;
          continue;
        }
        classificationsByKey.set(parsed.source_key, parsed);
        continue;
      }

      if (recordType === "table_row") {
        valid += 1;
        pendingRows.push({ obj: value, sourceFile: source.sourceFile, lineNumber });
        continue;
      }

      invalid += 1;
      issues.push({
        lineNumber,
        sourceFile: source.sourceFile,
        code: "SCHEMA",
        error: `Unbekannter record_type: ${recordType || "(leer)"}`,
        rawPreview: raw.slice(0, 200),
      });
    }
  }

  let missing_definitions = 0;

  for (const pending of pendingRows) {
    const obj = pending.obj;
    const system_id = asString(obj.system_id);
    const client = asString(obj.client);
    const table_name = asString(obj.table_name).toUpperCase();
    if (!system_id || !client || !table_name) {
      invalid += 1;
      valid -= 1;
      issues.push({
        lineNumber: pending.lineNumber,
        sourceFile: pending.sourceFile,
        code: "SCHEMA",
        error: "table_row: system_id/client/table_name fehlen",
        rawPreview: JSON.stringify(obj).slice(0, 200),
      });
      continue;
    }

    const defKey = buildTableDefinitionSourceKey(system_id, client, table_name);
    const definition = definitionsByKey.get(defKey);
    if (!definition) {
      missing_definitions += 1;
      issues.push({
        lineNumber: pending.lineNumber,
        sourceFile: pending.sourceFile,
        code: "MISSING_DEFINITION",
        source_key: defKey,
        error: `Keine table_definition für ${table_name}`,
        rawPreview: JSON.stringify(obj).slice(0, 200),
      });
    }

    const keyFields =
      definition?.key_fields ??
      Object.keys(isPlainObject(obj.primary_key) ? obj.primary_key : {}).sort();
    const primary_key = stringMap(obj.primary_key);
    const values = stringMap(obj.values);

    // Prefer DDIC key order; if primary_key empty, derive from values
    const pkSource =
      Object.keys(primary_key).length > 0
        ? primary_key
        : Object.fromEntries(
            keyFields.map((f) => [f, values[f] ?? values[f.toUpperCase()] ?? ""]),
          );

    const missingKeyFields = keyFields.filter(
      (f) => normalizeCellValue(pkSource[f] ?? pkSource[f.toUpperCase()]) === "",
    );
    // Client-dependent tables often omit empty optional keys; require all declared keys present in pk object
    const incomplete = keyFields.some((f) => {
      const has =
        Object.prototype.hasOwnProperty.call(pkSource, f) ||
        Object.keys(pkSource).some((k) => k.toUpperCase() === f.toUpperCase());
      return !has;
    });
    if (incomplete && keyFields.length > 0) {
      incomplete_keys += 1;
      issues.push({
        lineNumber: pending.lineNumber,
        sourceFile: pending.sourceFile,
        code: "INCOMPLETE_KEY",
        error: `Unvollständige Schlüsselfelder für ${table_name}: fehlend ${missingKeyFields.join(",") || "(Struktur)"}`,
        rawPreview: JSON.stringify(pkSource).slice(0, 200),
      });
    }

    // Align pk to DDIC names
    const orderedPk: Record<string, string> = {};
    for (const f of keyFields) {
      const found = Object.entries(pkSource).find(
        ([k]) => k.toUpperCase() === f.toUpperCase(),
      );
      orderedPk[f] = found ? found[1] : "";
    }
    if (keyFields.length === 0) {
      for (const [k, v] of Object.entries(pkSource).sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        orderedPk[k] = v;
      }
    }

    const canonicalPk = serializeCanonicalPrimaryKey(
      keyFields.length ? keyFields : Object.keys(orderedPk),
      orderedPk,
    );
    const source_key = buildTableRowSourceKey(
      system_id,
      client,
      table_name,
      canonicalPk,
    );
    const normalized_values = normalizedMap(values);
    const row_hash = sha256(
      stableStringify({
        primary_key: orderedPk,
        values,
      }),
    );

    const body = {
      system_id,
      client,
      table_name,
      primary_key: orderedPk,
      values,
      normalized_values,
      row_hash,
      classification: asString(obj.classification),
      classification_score: asNumber(obj.classification_score, 0),
    };

    const row: CanonicalTableRow = {
      record_type: "table_row",
      schema_version: CONTROL_TABLE_SCHEMA_VERSION,
      source_key,
      ...body,
      content_hash: sha256(stableStringify(body)),
      source_file: pending.sourceFile,
    };

    const status = trackSeen(
      seenRow,
      row.source_key,
      row.row_hash,
      pending.lineNumber,
      pending.sourceFile,
      issues,
      "ROW_KEY_COLLISION",
    );
    if (status === "duplicate") {
      duplicates += 1;
      continue;
    }
    if (status === "collision") {
      key_collisions += 1;
      continue;
    }
    rowsByKey.set(row.source_key, row);
  }

  const definitions = [...definitionsByKey.values()].sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );
  const classifications = [...classificationsByKey.values()].sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );
  const rows = [...rowsByKey.values()].sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );

  const entities: TableEntity[] = [];
  const relations: TableRelation[] = [];

  for (const definition of definitions) {
    relations.push(...buildDefinitionRelations(definition));
  }

  const defLookup = new Map(definitions.map((d) => [d.source_key, d]));
  for (const row of rows) {
    const defKey = buildTableDefinitionSourceKey(
      row.system_id,
      row.client,
      row.table_name,
    );
    const built = buildRowRelationsAndEntities({
      row,
      definition: defLookup.get(defKey),
    });
    entities.push(...built.entities);
    relations.push(...built.relations);
  }

  const finalizedRelations = finalizeRelationHashes(relations).sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );
  const sortedEntities = entities.sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );

  return {
    definitions,
    classifications,
    rows,
    entities: sortedEntities,
    relations: finalizedRelations,
    stats: {
      lines_total,
      valid,
      invalid,
      definitions: definitions.length,
      classifications: classifications.length,
      rows: rows.length,
      unique_tables: definitions.length,
      tables_with_rows: new Set(rows.map((r) => r.table_name)).size,
      entities: sortedEntities.length,
      relations: finalizedRelations.length,
      duplicates,
      key_collisions,
      missing_definitions,
      incomplete_keys,
    },
    issues,
  };
}
