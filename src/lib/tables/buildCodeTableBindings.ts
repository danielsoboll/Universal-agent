import type { TableCorpusBundle } from "@/lib/tables/loadCanonicalTables";
import {
  sha256Stable,
  shortId,
  type CodeTableBinding,
  type TableRowEvidence,
  type TableRuleGroup,
} from "@/lib/tables/types";

function parseClassMethod(codeSourceKey: string): {
  program_or_class: string;
  unit_name: string;
} {
  const parts = codeSourceKey.split("|");
  // D01|CLASS|ZCL_X|METHOD|Y
  const classIdx = parts.indexOf("CLASS");
  const methodIdx = parts.indexOf("METHOD");
  if (classIdx >= 0 && parts[classIdx + 1]) {
    return {
      program_or_class: parts[classIdx + 1]!,
      unit_name:
        methodIdx >= 0 && parts[methodIdx + 1]
          ? parts[methodIdx + 1]!
          : parts[parts.length - 1]!,
    };
  }
  return {
    program_or_class: parts[2] ?? codeSourceKey,
    unit_name: parts[parts.length - 1] ?? "",
  };
}

/**
 * Reuse existing accesses + links + dynamic accesses into uniform bindings.
 */
export function buildCodeTableBindings(params: {
  bundle: TableCorpusBundle;
  rows: TableRowEvidence[];
  ruleGroups: TableRuleGroup[];
}): CodeTableBinding[] {
  const rowsByTable = new Map<string, TableRowEvidence[]>();
  for (const r of params.rows) {
    const list = rowsByTable.get(r.table_name) ?? [];
    list.push(r);
    rowsByTable.set(r.table_name, list);
  }
  const groupsByTable = new Map<string, TableRuleGroup[]>();
  for (const g of params.ruleGroups) {
    const list = groupsByTable.get(g.table_name) ?? [];
    list.push(g);
    groupsByTable.set(g.table_name, list);
  }

  const bindings: CodeTableBinding[] = [];
  const seen = new Set<string>();

  for (const a of params.bundle.accesses) {
    const filters = (a.where ?? []).map((w) => {
      const val = w.resolved_literal ?? w.raw_value ?? "";
      return `${w.field ?? "?"}${w.operator ?? "="}${val}`;
    });
    const resolved = matchRows(rowsByTable.get(a.table_name) ?? [], a);
    const groups = matchGroups(groupsByTable.get(a.table_name) ?? [], resolved);
    const { program_or_class, unit_name } = parseClassMethod(a.code_source_key);
    const content_hash = sha256Stable([
      a.code_source_key,
      a.table_name,
      a.access_kind ?? "",
      a.evidence_code ?? "",
      String(a.line_start ?? ""),
    ]);
    const binding_id = `ctb:${shortId(content_hash)}`;
    if (seen.has(binding_id)) continue;
    seen.add(binding_id);
    bindings.push({
      binding_id,
      code_source_key: a.code_source_key,
      program_or_class,
      unit_name,
      table_name: a.table_name,
      access_kind: a.access_kind ?? "READ",
      access_mode: "static",
      fields: a.selected_fields ?? [],
      key_filters: filters,
      resolved_row_ids: resolved.map((r) => r.row_id),
      resolved_rule_group_ids: groups.map((g) => g.rule_group_id),
      evidence_from_code: a.evidence_code ? [a.evidence_code] : [],
      evidence_from_table: resolved.slice(0, 3).map((r) => r.source_ref),
      confidence: resolved.length ? 0.85 : 0.55,
      content_hash,
    });
  }

  for (const d of params.bundle.dynamicAccesses) {
    if (!d.code_source_key || !d.table_name) continue;
    const { program_or_class, unit_name } = parseClassMethod(d.code_source_key);
    const content_hash = sha256Stable([
      d.code_source_key,
      d.table_name,
      "dynamic",
      d.unresolved_reason ?? "",
      String(d.line_start ?? ""),
      ...(d.evidence ?? []),
    ]);
    const binding_id = `ctb:${shortId(content_hash)}`;
    if (seen.has(binding_id)) continue;
    seen.add(binding_id);
    bindings.push({
      binding_id,
      code_source_key: d.code_source_key,
      program_or_class,
      unit_name,
      table_name: d.table_name,
      access_kind: d.access_kind ?? "READ",
      access_mode: "dynamic",
      fields: [],
      key_filters: [],
      resolved_row_ids: [],
      resolved_rule_group_ids: [],
      evidence_from_code: d.evidence ?? [],
      evidence_from_table: [],
      confidence: 0.35,
      content_hash,
    });
  }

  // Supplement from RESOLVES_TABLE_ROW links not already covered
  for (const l of params.bundle.links) {
    if (l.relation_type !== "RESOLVES_TABLE_ROW") continue;
    const tableName =
      (typeof l.metadata?.table_name === "string" && l.metadata.table_name) ||
      (l.to_key.includes("|")
        ? l.to_key.split("|").slice(-1)[0]!
        : l.to_key);
    const { program_or_class, unit_name } = parseClassMethod(l.from_key);
    const content_hash = sha256Stable([
      l.from_key,
      tableName,
      l.relation_type,
      ...(l.evidence_from_code ?? []),
    ]);
    const binding_id = `ctb:${shortId(content_hash)}`;
    if (seen.has(binding_id)) continue;
    seen.add(binding_id);
    const resolved = (rowsByTable.get(tableName) ?? []).filter((r) =>
      (l.evidence_from_table ?? []).some(
        (ev) => ev.includes(r.normalized_key) || ev.includes(r.row_id),
      ),
    );
    bindings.push({
      binding_id,
      code_source_key: l.from_key,
      program_or_class,
      unit_name,
      table_name: tableName,
      access_kind: "READ",
      access_mode: "static",
      fields: [],
      key_filters: [],
      resolved_row_ids: resolved.map((r) => r.row_id),
      resolved_rule_group_ids: [],
      evidence_from_code: l.evidence_from_code ?? [],
      evidence_from_table: l.evidence_from_table ?? [],
      confidence: l.confidence ?? 0.8,
      content_hash,
    });
  }

  return bindings.sort((a, b) =>
    a.table_name === b.table_name
      ? a.code_source_key.localeCompare(b.code_source_key)
      : a.table_name.localeCompare(b.table_name),
  );
}

function matchRows(
  rows: TableRowEvidence[],
  access: {
    table_name: string;
    where?: Array<{
      field?: string;
      resolved_literal?: string;
      raw_value?: string;
    }>;
  },
): TableRowEvidence[] {
  const literals = (access.where ?? []).filter(
    (w) => w.field && (w.resolved_literal || w.raw_value),
  );
  if (!literals.length) return [];
  return rows.filter((row) =>
    literals.every((w) => {
      const want = String(w.resolved_literal ?? w.raw_value ?? "").trim();
      const got = String(
        row.field_values[w.field!] ??
          row.normalized_key
            .split("|")
            .find((p) => p.startsWith(`${w.field}=`))
            ?.split("=")[1] ??
          "",
      ).trim();
      if (!got) return false;
      if (got === want) return true;
      const g = got.replace(/^0+/, "") || "0";
      const n = want.replace(/^0+/, "") || "0";
      return g === n;
    }),
  );
}

function matchGroups(
  groups: TableRuleGroup[],
  resolved: TableRowEvidence[],
): TableRuleGroup[] {
  if (!resolved.length) return [];
  const refs = new Set(resolved.map((r) => r.source_ref));
  return groups.filter((g) =>
    g.row_evidence_refs.some((ref) => refs.has(ref)),
  );
}
