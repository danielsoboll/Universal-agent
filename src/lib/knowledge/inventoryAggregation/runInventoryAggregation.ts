/**
 * INVENTORY_AND_AGGREGATION_RESOLVER
 *
 * Set/list questions over message/output configuration — deterministic
 * enumeration, filter, join, count. No Top-k answer path.
 */
import { BOUND_DATA_PROJECT_KEY } from "@/lib/localData/boundProject";
import { classifyInventoryIntent } from "./classifyInventoryIntent";
import { loadMessageIdocInventoryCorpus } from "./loadMessageIdocInventory";
import { resolveDeliveryApplication } from "./resolveDeliveryApplication";
import {
  aggregateInventory,
  buildOutputInventoryRows,
} from "./buildInventory";
import {
  buildInventoryAnswerView,
  buildInventorySummarySentence,
} from "./formatInventoryAnswer";
import type {
  ApplicationSelection,
  InventoryAggregationResult,
} from "./types";

const EMPTY_SELECTION: ApplicationSelection = {
  selected_application: null,
  selection_method: "output_type_text_delivery_density",
  score: 0,
  matching_text_count: 0,
  total_text_count: 0,
  confidence: "LOW",
  reason: "",
};

export async function runInventoryAggregationResolver(params: {
  question: string;
  projectKey?: string;
}): Promise<InventoryAggregationResult> {
  const started = Date.now();
  const classification = classifyInventoryIntent(params.question);

  const empty = (
    extras: Partial<InventoryAggregationResult>,
  ): InventoryAggregationResult => ({
    used: false,
    classification,
    application: null,
    application_reason: "",
    application_selection: null,
    rows: [],
    filtered_rows: [],
    other_media_rows: [],
    aggregation: {
      total_output_types: 0,
      edi_medium_output_types: 0,
      other_media_output_types: 0,
      medium_distribution: [],
      fully_resolved_chains: 0,
      unresolved_edi_chains: 0,
      resolved_message_type_count: 0,
      resolved_idoc_type_count: 0,
    },
    answer_markdown: "",
    summary_sentence: "",
    answer_view: null,
    diagnostics: {
      intent: classification,
      delivery_application: null,
      delivery_application_reason: "",
      application_selection: null,
      total_output_types: 0,
      medium_distribution: [],
      edi_filtered_output_types: [],
      resolved_message_types: [],
      resolved_idoc_types: [],
      unresolved_chains: [],
      sources: [],
      duration_ms: Date.now() - started,
      first_five_cards: [],
    },
    sources: [],
    duration_ms: Date.now() - started,
    ...extras,
  });

  if (classification.intent !== "INVENTORY_AND_AGGREGATION") {
    return empty({});
  }

  if (classification.entity_domain !== "DELIVERY_OUTPUT") {
    return empty({
      used: false,
      summary_sentence:
        "Inventar-Resolver greift nur für Liefer-/Versand-Nachrichtenfragen.",
      answer_markdown:
        "Inventar-Resolver greift nur für Liefer-/Versand-Nachrichtenfragen.",
    });
  }

  const projectKey = params.projectKey?.trim() || BOUND_DATA_PROJECT_KEY;
  const corpus = await loadMessageIdocInventoryCorpus(projectKey);
  const appRes = resolveDeliveryApplication({
    output_types: corpus.output_types,
    texts: corpus.texts,
  });

  if (!appRes.application) {
    return empty({
      used: true,
      application_reason: appRes.reason,
      application_selection: appRes.selection,
      summary_sentence: appRes.reason,
      answer_markdown: appRes.reason,
      sources: corpus.sources_present,
      diagnostics: {
        intent: classification,
        delivery_application: null,
        delivery_application_reason: appRes.reason,
        application_selection: appRes.selection,
        total_output_types: 0,
        medium_distribution: [],
        edi_filtered_output_types: [],
        resolved_message_types: [],
        resolved_idoc_types: [],
        unresolved_chains: [],
        sources: corpus.sources_present,
        duration_ms: Date.now() - started,
        first_five_cards: [],
      },
    });
  }

  const rows = buildOutputInventoryRows({
    corpus,
    application: appRes.application,
  });
  const aggregation = aggregateInventory(rows);

  // Main answer filter: Medium 6 / EDI only when IDOC_OR_EDI requested
  const filter = classification.requested_filter;
  const ediRows = rows.filter((r) => r.is_edi_medium);
  const otherRows = rows.filter((r) => !r.is_edi_medium);
  const filtered_rows = filter === "IDOC_OR_EDI" ? ediRows : rows;
  const other_media_rows = filter === "IDOC_OR_EDI" ? otherRows : [];

  const selection = appRes.selection;
  const summary = buildInventorySummarySentence({
    selection,
    aggregation,
    filter: filter === "NONE" ? "ALL_MEDIA" : filter,
  });

  const answer_view = buildInventoryAnswerView({
    selection,
    aggregation,
    filter: filter === "NONE" ? "ALL_MEDIA" : filter,
    all_rows: rows,
    filtered_rows,
    other_media_rows,
    sources: corpus.sources_present,
  });

  const ediTypes = [...new Set(ediRows.map((r) => r.output_type))].sort();
  const resolved_message_types = [
    ...new Set(
      ediRows.map((r) => r.message_type).filter((x): x is string => Boolean(x)),
    ),
  ].sort();
  const resolved_idoc_types = [
    ...new Set(
      ediRows.map((r) => r.idoc_type).filter((x): x is string => Boolean(x)),
    ),
  ].sort();
  const unresolved_chains = ediTypes
    .filter((t) => {
      const rs = ediRows.filter((r) => r.output_type === t);
      return !rs.some((r) => r.chain_complete);
    })
    .map((t) => {
      const row = ediRows.find((r) => r.output_type === t)!;
      return {
        output_type: t,
        note: row.evidence_status,
      };
    });

  const duration_ms = Date.now() - started;
  return {
    used: true,
    classification,
    application: appRes.application,
    application_reason: appRes.reason,
    application_selection: selection,
    rows,
    filtered_rows,
    other_media_rows,
    aggregation,
    summary_sentence: summary,
    answer_view,
    answer_markdown: summary,
    sources: corpus.sources_present,
    duration_ms,
    diagnostics: {
      intent: classification,
      delivery_application: appRes.application,
      delivery_application_reason: appRes.reason,
      application_selection: selection,
      total_output_types: aggregation.total_output_types,
      medium_distribution: aggregation.medium_distribution,
      edi_filtered_output_types: ediTypes,
      resolved_message_types,
      resolved_idoc_types,
      unresolved_chains,
      sources: corpus.sources_present,
      duration_ms,
      first_five_cards: answer_view.filtered_items.slice(0, 5),
    },
  };
}

export { EMPTY_SELECTION };
