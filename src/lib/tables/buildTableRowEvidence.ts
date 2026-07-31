import type { CanonicalTableRow } from "@/lib/ingest/controlTables/model";
import type { TableCorpusBundle } from "@/lib/tables/loadCanonicalTables";
import type {
  TableKnowledgeUnit,
  TableRowEvidence,
  TableRuleGroup,
} from "@/lib/tables/types";

function pkString(row: CanonicalTableRow): string {
  return Object.entries(row.primary_key ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

function rowInRuleGroup(
  row: CanonicalTableRow,
  groups: TableRuleGroup[],
): boolean {
  const ref = `CanonicalTableRow:${row.source_key}`;
  return groups.some(
    (g) =>
      g.table_name === row.table_name &&
      g.row_count >= 2 &&
      g.row_evidence_refs.includes(ref),
  );
}

function isHardcodingLike(row: CanonicalTableRow): boolean {
  const vals = Object.values(row.values ?? {}).map((v) => String(v).trim());
  return vals.some(
    (v) =>
      v === "X" ||
      v === "Y" ||
      v === "N" ||
      /^[01]$/.test(v) ||
      (v.length >= 2 && v.length <= 6 && /^[A-Z0-9_]+$/.test(v)),
  );
}

function resolveReferencedRowKeys(bundle: TableCorpusBundle): Set<string> {
  const keys = new Set<string>();
  for (const l of bundle.links) {
    if (l.relation_type === "RESOLVES_TABLE_ROW") {
      // evidence_from_table often "TABLE|PK → {...}"
      for (const ev of l.evidence_from_table ?? []) {
        const m = /^([^|]+\|[^→]+)/.exec(ev);
        if (m) {
          // try match against source_key endings
        }
      }
      const meta = l.metadata ?? {};
      if (typeof meta.resolved_key === "string") {
        keys.add(String(meta.resolved_key));
      }
    }
  }
  for (const a of bundle.accesses) {
    for (const w of a.where ?? []) {
      if (w.value_kind === "literal" && w.resolved_literal && w.field) {
        keys.add(`${a.table_name}|${w.field}=${w.resolved_literal}`);
        // also padded numeric forms
        const lit = w.resolved_literal.replace(/^0+/, "") || "0";
        keys.add(`${a.table_name}|${w.field}=${lit}`);
        keys.add(`${a.table_name}|${w.field}=${w.resolved_literal}`);
      }
    }
  }
  return keys;
}

function rowMatchesResolved(
  row: CanonicalTableRow,
  resolvedHints: Set<string>,
): boolean {
  if (resolvedHints.has(row.source_key)) return true;
  const pk = pkString(row);
  if (resolvedHints.has(`${row.table_name}|${pk}`)) return true;
  for (const [k, v] of Object.entries(row.primary_key ?? {})) {
    if (k.toUpperCase() === "MANDT") continue;
    if (resolvedHints.has(`${row.table_name}|${k}=${v}`)) return true;
    const stripped = String(v).replace(/^0+/, "") || "0";
    if (resolvedHints.has(`${row.table_name}|${k}=${stripped}`)) return true;
  }
  return false;
}

/**
 * Every canonical row stays addressable. Only selected rows become
 * primary SearchDocuments.
 */
export function buildTableRowEvidence(params: {
  bundle: TableCorpusBundle;
  units: TableKnowledgeUnit[];
  ruleGroups: TableRuleGroup[];
}): TableRowEvidence[] {
  const unitByTable = new Map(params.units.map((u) => [u.table_name, u]));
  const resolvedHints = resolveReferencedRowKeys(params.bundle);
  const out: TableRowEvidence[] = [];

  for (const row of params.bundle.rows) {
    const unit = unitByTable.get(row.table_name);
    const inGroup = rowInRuleGroup(row, params.ruleGroups);
    let primary = false;
    let reason: string | null = null;

    if (rowMatchesResolved(row, resolvedHints)) {
      primary = true;
      reason = "code_resolved_row";
    } else if (
      unit?.referenced_by_code &&
      unit.classification === "CUSTOMIZING_CONTROL_TABLE" &&
      unit.row_count > 0 &&
      unit.row_count <= 80
    ) {
      primary = true;
      reason = "code_referenced_customizing_row";
    } else if (unit?.referenced_by_code && isHardcodingLike(row)) {
      primary = true;
      reason = "code_referenced_hardcoding_like";
    } else if (
      unit?.referenced_by_code &&
      (unit.classification === "CUSTOMIZING_CONTROL_TABLE" ||
        unit.classification === "REVIEW_CANDIDATE") &&
      unit.row_count <= 100 &&
      !inGroup
    ) {
      primary = true;
      reason = "code_referenced_ungrouped_control_row";
    } else if (
      !inGroup &&
      unit?.classification === "CUSTOMIZING_CONTROL_TABLE" &&
      unit.row_count > 0 &&
      unit.row_count <= 20 &&
      Number(row.classification_score ?? 0) >= 15
    ) {
      // Small customizing tables: keep rows searchable even without code link yet
      primary = true;
      reason = "small_customizing_high_score_row";
    }

    out.push({
      row_id: row.source_key,
      table_name: row.table_name,
      normalized_key: pkString(row),
      field_values: { ...(row.values ?? {}) },
      source_ref: `CanonicalTableRow:${row.source_key}`,
      content_hash: row.content_hash,
      primary_search_document: primary,
      primary_reason: reason,
    });
  }

  return out;
}
