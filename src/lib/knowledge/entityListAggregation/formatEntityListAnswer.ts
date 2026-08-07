/**
 * Build structured ENTITY_LIST answer for UI (no raw evidence dump).
 */
import type {
  EntityListAnswerView,
  EntityListCardItem,
  EntityListQueryClassification,
} from "./types";

export function buildEntityListSummarySentence(params: {
  classification: EntityListQueryClassification;
  primary_count: number;
  supporting_count: number;
  unclear_count: number;
}): string {
  const { classification, primary_count, supporting_count } = params;
  const label = classification.topic_label;
  const entityWord =
    classification.requested_entity_type === "CLASS"
      ? "Klassen"
      : classification.requested_entity_type === "PROGRAM"
        ? "Programme"
        : classification.requested_entity_type === "TABLE"
          ? "Tabellen"
          : classification.requested_entity_type === "METHOD"
            ? "Methoden"
            : classification.requested_entity_type === "FUNCTION_MODULE"
              ? "Funktionsbausteine"
              : "Objekte";

  return (
    `Im aktuellen Datenbestand wurden ${primary_count} primäre und ` +
    `${supporting_count} unterstützende ${label}-${entityWord} gefunden` +
    (params.unclear_count > 0
      ? `; ${params.unclear_count} Treffer bleiben unklar.`
      : ".")
  );
}

export function buildEntityListAnswerView(params: {
  classification: EntityListQueryClassification;
  items: EntityListCardItem[];
  filtered_out: Array<{ kind: string; name: string; note: string }>;
  raw_hit_count: number;
  sources: string[];
}): EntityListAnswerView {
  const primary_items = params.items.filter((i) => i.role === "PRIMARY");
  const supporting_items = params.items.filter((i) => i.role === "SUPPORTING");
  const unclear_items = params.items.filter((i) => i.role === "UNCLEAR");
  const text = buildEntityListSummarySentence({
    classification: params.classification,
    primary_count: primary_items.length,
    supporting_count: supporting_items.length,
    unclear_count: unclear_items.length,
  });

  return {
    summary: {
      text,
      topic: params.classification.topic,
      topic_label: params.classification.topic_label,
      requested_entity_type: params.classification.requested_entity_type,
      raw_hit_count: params.raw_hit_count,
      unique_entity_count: params.items.length,
      primary_count: primary_items.length,
      supporting_count: supporting_items.length,
      unclear_count: unclear_items.length,
    },
    primary_items,
    supporting_items,
    unclear_items,
    filtered_out_evidence: params.filtered_out,
    sources: params.sources,
  };
}
