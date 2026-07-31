import type { CanonicalTableRow } from "@/lib/ingest/controlTables/model";
import type { TableCorpusBundle } from "@/lib/tables/loadCanonicalTables";
import {
  sha256Stable,
  shortId,
  type TableKnowledgeUnit,
  type TableRuleGroup,
} from "@/lib/tables/types";

function nonClientKeys(keyFields: string[]): string[] {
  return keyFields.filter(
    (k) => !["MANDT", "CLIENT", "CLIENT_ID"].includes(k.toUpperCase()),
  );
}

function pkString(row: CanonicalTableRow): string {
  return Object.entries(row.primary_key ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

function valueStructureSignature(row: CanonicalTableRow): string {
  const pk = new Set(Object.keys(row.primary_key ?? {}));
  return Object.entries(row.values ?? {})
    .filter(([k, v]) => !pk.has(k) && String(v ?? "").trim() !== "")
    .map(([k]) => k)
    .sort()
    .join("|");
}

function sampleValues(rows: CanonicalTableRow[], field: string, limit = 8): string[] {
  const vals = new Set<string>();
  for (const r of rows) {
    const v = r.values?.[field] ?? r.primary_key?.[field];
    if (v != null && String(v).trim()) vals.add(String(v).slice(0, 80));
    if (vals.size >= limit) break;
  }
  return [...vals];
}

function textishFields(unit: TableKnowledgeUnit): string[] {
  return unit.fields
    .filter((f) => {
      const n = f.field_name.toUpperCase();
      const d = f.description.toUpperCase();
      return (
        /TEXT|BEZ|DESCR|NAME|BEMERK|HINWEIS/.test(n) ||
        /TEXT|BEZEICH|DESCR/.test(d) ||
        (f.data_type === "CHAR" && f.length >= 20 && !f.key)
      );
    })
    .map((f) => f.field_name);
}

/**
 * Build rule groups only when aggregation is structurally justified.
 * No synthetic one-row-per-key groups for parameter dumps.
 */
export function buildTableRuleGroups(params: {
  bundle: TableCorpusBundle;
  units: TableKnowledgeUnit[];
}): TableRuleGroup[] {
  const unitByTable = new Map(params.units.map((u) => [u.table_name, u]));
  const groups: TableRuleGroup[] = [];

  for (const [tableName, rows] of params.bundle.rowsByTable) {
    const unit = unitByTable.get(tableName);
    if (!unit) continue;
    if (rows.length < 4) continue;
    if (unit.classification === "NON_CONTROL_TABLE" && rows.length > 80) {
      continue;
    }

    const keys = nonClientKeys(unit.key_fields);
    let emitted = false;

    // Strategy A: parent key (composite) with average children >= 2
    if (keys.length >= 2) {
      const parent = keys[0]!;
      const byParent = new Map<string, CanonicalTableRow[]>();
      for (const row of rows) {
        const pv = String(row.primary_key?.[parent] ?? row.values?.[parent] ?? "");
        if (!pv) continue;
        const list = byParent.get(pv) ?? [];
        list.push(row);
        byParent.set(pv, list);
      }
      const usable = [...byParent.entries()].filter(([, rs]) => rs.length >= 2);
      if (usable.length >= 2 && usable.length < rows.length) {
        for (const [parentVal, rs] of usable) {
          groups.push(
            makeGroup({
              tableName,
              strategy: "parent_key",
              groupKey: `${parent}=${parentVal}`,
              title: `${tableName} · ${parent}=${parentVal}`,
              rows: rs,
              controlling: [parent, ...keys.slice(1, 3)],
              unit,
            }),
          );
        }
        emitted = true;
      }
    }

    if (emitted) continue;

    // Strategy B: shared non-key value structure when it aggregates well
    const bySig = new Map<string, CanonicalTableRow[]>();
    for (const row of rows) {
      const sig = valueStructureSignature(row);
      if (!sig) continue;
      const list = bySig.get(sig) ?? [];
      list.push(row);
      bySig.set(sig, list);
    }
    const structGroups = [...bySig.entries()].filter(([, rs]) => rs.length >= 3);
    if (
      structGroups.length >= 2 &&
      structGroups.length <= Math.floor(rows.length * 0.7)
    ) {
      for (const [sig, rs] of structGroups) {
        const fields = sig.split("|").filter(Boolean);
        groups.push(
          makeGroup({
            tableName,
            strategy: "value_structure",
            groupKey: `struct:${shortId(sha256Stable([sig]), 12)}`,
            title: `${tableName} · Felder ${fields.slice(0, 4).join(", ")}`,
            rows: rs,
            controlling: fields.slice(0, 6),
            unit,
          }),
        );
      }
      emitted = true;
    }

    if (emitted) continue;

    // Strategy C: text-prefix clusters for mid-size control/customizing tables
    if (
      (unit.classification === "CUSTOMIZING_CONTROL_TABLE" ||
        unit.classification === "REVIEW_CANDIDATE") &&
      rows.length >= 8 &&
      rows.length <= 120
    ) {
      const textFields = textishFields(unit);
      const field = textFields[0];
      if (field) {
        const byPrefix = new Map<string, CanonicalTableRow[]>();
        for (const row of rows) {
          const text = String(row.values?.[field] ?? "").trim();
          if (text.length < 8) continue;
          const prefix = text.slice(0, 12).toLowerCase();
          const list = byPrefix.get(prefix) ?? [];
          list.push(row);
          byPrefix.set(prefix, list);
        }
        const clusters = [...byPrefix.entries()].filter(([, rs]) => rs.length >= 3);
        if (clusters.length >= 2 && clusters.length < rows.length / 2) {
          for (const [prefix, rs] of clusters) {
            groups.push(
              makeGroup({
                tableName,
                strategy: "text_prefix",
                groupKey: `${field}~${prefix}`,
                title: `${tableName} · ${field} „${prefix}…“`,
                rows: rs,
                controlling: [field, ...keys.slice(0, 2)],
                unit,
              }),
            );
          }
        }
      }
    }
  }

  return groups.sort((a, b) =>
    a.table_name === b.table_name
      ? a.group_key.localeCompare(b.group_key)
      : a.table_name.localeCompare(b.table_name),
  );
}

function makeGroup(params: {
  tableName: string;
  strategy: string;
  groupKey: string;
  title: string;
  rows: CanonicalTableRow[];
  controlling: string[];
  unit: TableKnowledgeUnit;
}): TableRuleGroup {
  const rowRefs = params.rows.map((r) => `CanonicalTableRow:${r.source_key}`);
  const keys = params.rows.map(pkString).slice(0, 12);
  const controlled: string[] = [];
  for (const f of params.controlling.slice(0, 4)) {
    controlled.push(...sampleValues(params.rows, f, 4).map((v) => `${f}=${v}`));
  }

  const facts = [
    `Tabelle ${params.tableName}`,
    `Gruppe ${params.groupKey}`,
    `Zeilen in Gruppe: ${params.rows.length}`,
    params.controlling.length
      ? `Steuernde Felder: ${params.controlling.join(", ")}`
      : "",
  ].filter(Boolean);

  const cautious_inferences = [
    `Gruppierung über Strategie „${params.strategy}“ — fachliche Regel nicht automatisch bewiesen`,
  ];

  const content_hash = sha256Stable([
    params.tableName,
    params.strategy,
    params.groupKey,
    ...params.rows.map((r) => r.content_hash).sort(),
  ]);

  return {
    rule_group_id: `trg:${shortId(content_hash)}`,
    table_name: params.tableName,
    group_key: params.groupKey,
    title: params.title,
    row_count: params.rows.length,
    key_range_or_values: keys,
    controlling_fields: params.controlling,
    controlled_values: [...new Set(controlled)].slice(0, 20),
    facts,
    cautious_inferences,
    code_references: params.unit.code_references.slice(0, 12),
    row_evidence_refs: rowRefs,
    confidence: Math.min(
      0.85,
      0.35 + Math.min(0.4, params.rows.length / 50) +
        (params.unit.referenced_by_code ? 0.1 : 0),
    ),
    content_hash,
    grouping_strategy: params.strategy,
  };
}
