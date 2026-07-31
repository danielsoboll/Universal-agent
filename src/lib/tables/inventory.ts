import {
  extractLinkedTableNames,
  type TableCorpusBundle,
} from "@/lib/tables/loadCanonicalTables";

export type TableInventoryReport = {
  tables_total: number;
  classifications_total: number;
  rows_total: number;
  tables_with_rows: number;
  tables_without_rows: number;
  tables_without_key_fields: number;
  likely_control_tables: number;
  review_candidates: number;
  non_control_tables: number;
  tables_linked_to_code: number;
  dynamic_unresolved_accesses: number;
  code_accesses_total: number;
  code_links_total: number;
  ingest_duplicates: number;
  ingest_key_collisions: number;
  classification_breakdown: Record<string, number>;
};

export function buildTableInventory(
  bundle: TableCorpusBundle,
): TableInventoryReport {
  const linked = extractLinkedTableNames(bundle);
  const breakdown: Record<string, number> = {};
  for (const c of bundle.classifications) {
    breakdown[c.classification] = (breakdown[c.classification] ?? 0) + 1;
  }

  const likely = bundle.classifications.filter(
    (c) => c.classification === "CUSTOMIZING_CONTROL_TABLE",
  ).length;
  const review = bundle.classifications.filter(
    (c) => c.classification === "REVIEW_CANDIDATE",
  ).length;
  const non = bundle.classifications.filter(
    (c) => c.classification === "NON_CONTROL_TABLE",
  ).length;

  return {
    tables_total: bundle.definitions.length,
    classifications_total: bundle.classifications.length,
    rows_total: bundle.rows.length,
    tables_with_rows: bundle.rowsByTable.size,
    tables_without_rows:
      bundle.definitions.length - bundle.rowsByTable.size,
    tables_without_key_fields: bundle.definitions.filter(
      (d) => !d.key_fields?.length,
    ).length,
    likely_control_tables: likely,
    review_candidates: review,
    non_control_tables: non,
    tables_linked_to_code: [...linked].filter((t) =>
      bundle.definitionByTable.has(t),
    ).length,
    dynamic_unresolved_accesses: bundle.dynamicAccesses.length,
    code_accesses_total: bundle.accesses.length,
    code_links_total: bundle.links.length,
    ingest_duplicates: bundle.ingestReport?.stats?.duplicates ?? 0,
    ingest_key_collisions: bundle.ingestReport?.stats?.key_collisions ?? 0,
    classification_breakdown: breakdown,
  };
}
