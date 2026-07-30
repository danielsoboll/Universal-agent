import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchEntity } from "@/lib/search/searchDocumentSchema";

export type CanonicalTableRowInput = {
  source_key: string;
  table_name: string;
  primary_key: Record<string, string>;
  values: Record<string, string>;
  classification?: string;
  row_hash?: string;
  content_hash?: string;
  client?: string;
};

function pushEntity(list: SearchEntity[], kind: string, name: string) {
  const n = name.trim();
  if (!n) return;
  list.push({
    kind,
    name: n,
    normalized: normalizeSearchToken(n).toUpperCase(),
  });
}

export function draftFromCanonicalTableRow(params: {
  row: CanonicalTableRowInput;
  sourceSystem: string;
}): SearchDocumentDraft {
  const r = params.row;
  const pk = Object.entries(r.primary_key ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
  const valueEntries = Object.entries(r.values ?? {});
  const valueSummary = valueEntries
    .filter(([k]) => !(k in (r.primary_key ?? {})))
    .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
    .slice(0, 12);

  const facts = [
    `Tabelle ${r.table_name}`,
    pk ? `Primärschlüssel ${pk}` : "",
    ...valueSummary.map((v) => `Wert ${v}`),
  ].filter(Boolean);

  const entities: SearchEntity[] = [];
  pushEntity(entities, "table", r.table_name);
  pushEntity(entities, "resolved_key", pk);
  for (const [k, v] of Object.entries(r.primary_key ?? {})) {
    pushEntity(entities, "key_field", `${k}=${v}`);
  }
  for (const [k, v] of valueEntries.slice(0, 8)) {
    if (k in (r.primary_key ?? {})) continue;
    pushEntity(entities, "value_field", `${k}=${String(v).slice(0, 60)}`);
  }

  return {
    source_system: params.sourceSystem,
    source_type: "canonical_table_row",
    source_key: r.source_key,
    knowledge_unit_type: "control_table_row",
    object_type: "TABLE_ROW",
    object_name: r.table_name,
    subobject_name: pk,
    title: `${r.table_name} | ${pk}`,
    technical_summary: `Canonical table row ${r.table_name} ${pk}`,
    business_purpose: "",
    facts,
    inferences: [],
    entities,
    relations: [
      {
        relation_type: "ROW_OF_TABLE",
        from_type: "TABLE_ROW",
        from_name: r.source_key,
        to_type: "TABLE",
        to_name: r.table_name,
      },
    ],
    tables_read: [r.table_name],
    hardcoded_values: [pk, ...valueSummary],
    evidence: facts.map((text) => ({
      statement_type: "fact" as const,
      text,
      lines: [{ quote: `CanonicalTableRow:${r.source_key}` }],
    })),
    confidence: 1,
    analysis_version: "",
    metadata: {
      classification: r.classification ?? null,
      primary_key: r.primary_key,
      values: r.values,
      evidence_refs: [`CanonicalTableRow:${r.source_key}`],
      row_hash: r.row_hash ?? null,
      row_content_hash: r.content_hash ?? null,
    },
  };
}
