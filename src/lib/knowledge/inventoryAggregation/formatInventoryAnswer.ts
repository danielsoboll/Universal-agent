/**
 * Build structured inventory answer for UI (no markdown tables).
 */
import type {
  ApplicationSelection,
  InventoryAggregation,
  InventoryAnswerView,
  InventoryCardItem,
  InventoryRequestedFilter,
  OutputInventoryRow,
} from "./types";

/** One representative row per output type (prefer EDI medium 6 if present). */
export function collapseToOutputTypes(
  rows: OutputInventoryRow[],
): OutputInventoryRow[] {
  const byType = new Map<string, OutputInventoryRow[]>();
  for (const r of rows) {
    const list = byType.get(r.output_type) ?? [];
    list.push(r);
    byType.set(r.output_type, list);
  }
  const out: OutputInventoryRow[] = [];
  for (const [, list] of [...byType.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const edi = list.find((r) => r.is_edi_medium);
    out.push(edi ?? list[0]!);
  }
  return out;
}

export function rowToCard(row: OutputInventoryRow): InventoryCardItem {
  return {
    output_type: row.output_type,
    description: row.description,
    medium: row.transmission_medium,
    medium_text: row.medium_text,
    program: row.program,
    routine: row.routine,
    message_type: row.message_type,
    idoc_type: row.idoc_type,
    idoc_extension: row.idoc_extension,
    evidence_status: row.evidence_status,
    chain_complete: row.chain_complete,
  };
}

/** Sort: fully resolved chains first, then by output_type. */
export function sortEdiCards(rows: OutputInventoryRow[]): OutputInventoryRow[] {
  return [...rows].sort((a, b) => {
    if (a.chain_complete !== b.chain_complete) {
      return a.chain_complete ? -1 : 1;
    }
    return a.output_type.localeCompare(b.output_type);
  });
}

export function buildInventorySummarySentence(params: {
  selection: ApplicationSelection;
  aggregation: InventoryAggregation;
  filter: InventoryRequestedFilter;
}): string {
  const app = params.selection.selected_application ?? "?";
  const conf = params.selection.confidence;
  const { aggregation, filter } = params;
  const X = aggregation.edi_medium_output_types;
  const Y = aggregation.fully_resolved_chains;
  const Z = aggregation.unresolved_edi_chains;

  if (filter === "IDOC_OR_EDI") {
    return (
      `In der wahrscheinlichsten Lieferanwendung ${app} (Konfidenz ${conf}) ` +
      `sind ${aggregation.total_output_types} Nachrichtenarten konfiguriert. ` +
      `${X} davon verwenden Medium 6 (EDI). ` +
      `Für ${Y} EDI-Ausgaben ist die IDoc-Kette vollständig aufgelöst; ` +
      `bei ${Z} fehlt noch eine eindeutige Zuordnung.`
    );
  }
  return (
    `In der wahrscheinlichsten Lieferanwendung ${app} (Konfidenz ${conf}) ` +
    `sind ${aggregation.total_output_types} Nachrichtenarten konfiguriert.`
  );
}

export function buildInventoryAnswerView(params: {
  selection: ApplicationSelection;
  aggregation: InventoryAggregation;
  filter: InventoryRequestedFilter;
  /** All rows for the selected application. */
  all_rows: OutputInventoryRow[];
  filtered_rows: OutputInventoryRow[];
  other_media_rows: OutputInventoryRow[];
  sources: string[];
}): InventoryAnswerView {
  void params.other_media_rows;
  const allCollapsed = collapseToOutputTypes(params.all_rows);
  const ediCollapsed = sortEdiCards(
    collapseToOutputTypes(
      params.filtered_rows.filter((r) => r.is_edi_medium),
    ),
  );
  const mainCollapsed =
    params.filter === "IDOC_OR_EDI" ? ediCollapsed : allCollapsed;
  const unresolved = mainCollapsed.filter((r) => !r.chain_complete);
  // Display order: resolved first (already in sort), unresolved listed separately
  const filtered_items = mainCollapsed.map(rowToCard);
  const unresolved_items =
    params.filter === "IDOC_OR_EDI" ? unresolved.map(rowToCard) : [];
  // Remaining application output types (no overlap with main EDI list)
  const mainTypes = new Set(filtered_items.map((c) => c.output_type));
  const other_items = allCollapsed
    .filter((r) => !mainTypes.has(r.output_type))
    .map(rowToCard);

  const summary_text = buildInventorySummarySentence({
    selection: params.selection,
    aggregation: params.aggregation,
    filter: params.filter,
  });

  return {
    summary: {
      selected_application: params.selection.selected_application,
      application_selection: params.selection,
      total_output_types: params.aggregation.total_output_types,
      edi_medium_count: params.aggregation.edi_medium_output_types,
      resolved_message_type_count:
        params.aggregation.resolved_message_type_count,
      resolved_idoc_type_count: params.aggregation.resolved_idoc_type_count,
      fully_resolved_chain_count: params.aggregation.fully_resolved_chains,
      unresolved_chain_count: params.aggregation.unresolved_edi_chains,
      text: summary_text,
    },
    filtered_items,
    other_items,
    unresolved_items,
    sources: params.sources,
  };
}

/** @deprecated — summary text only; tables removed. */
export function formatInventoryAnswerMarkdown(params: {
  application: string;
  application_reason: string;
  summary: string;
  aggregation: InventoryAggregation;
  filter: InventoryRequestedFilter;
  filtered_rows: OutputInventoryRow[];
  other_media_rows: OutputInventoryRow[];
  sources: string[];
}): string {
  void params.application;
  void params.application_reason;
  void params.aggregation;
  void params.filter;
  void params.filtered_rows;
  void params.other_media_rows;
  void params.sources;
  return params.summary;
}
