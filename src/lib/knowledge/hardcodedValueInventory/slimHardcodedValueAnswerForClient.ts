/**
 * Slim hardcoded-value answer for API/client — keeps cards + summary, caps heavy occurrences.
 */
import type {
  HardcodedMaterialCard,
  HardcodedOccurrence,
  HardcodedValueAnswerView,
} from "./types";

const MAX_OCCURRENCES_PER_CARD = 8;

function slimOccurrence(o: HardcodedOccurrence): HardcodedOccurrence {
  return {
    material_number: o.material_number,
    material_number_internal: o.material_number_internal,
    original_literal: o.original_literal,
    source_key: o.source_key,
    object_type: o.object_type,
    object_name: o.object_name,
    unit_name: o.unit_name,
    unit_type: o.unit_type,
    line_number: o.line_number,
    snippet: o.snippet.slice(0, 220),
    condition: o.condition,
    action: o.action,
    tables_fields: o.tables_fields.slice(0, 6),
    active_code: o.active_code,
    comment_only: o.comment_only,
    confidence: o.confidence,
    claim_status: o.claim_status,
    process_label: o.process_label,
    process_rationale: o.process_rationale?.slice(0, 160) ?? null,
  };
}

function slimCard(card: HardcodedMaterialCard): HardcodedMaterialCard {
  const active = (card.occurrences ?? []).filter((o) => o.active_code);
  const pool = active.length ? active : card.occurrences ?? [];
  return {
    material_number: card.material_number,
    material_number_internal: card.material_number_internal,
    occurrence_count: card.occurrence_count,
    process_label: card.process_label,
    condition_summary: card.condition_summary,
    effect_summary: card.effect_summary,
    evidence_status: card.evidence_status,
    claim_status: card.claim_status,
    occurrences: pool.slice(0, MAX_OCCURRENCES_PER_CARD).map(slimOccurrence),
  };
}

export function slimHardcodedValueAnswerForClient(
  view: HardcodedValueAnswerView | null,
): HardcodedValueAnswerView | null {
  if (!view) return null;
  const materials = view.materials.map(slimCard);
  return {
    summary: view.summary,
    materials,
    multi_use: view.multi_use.map(slimCard),
    comment_or_unclear: view.comment_or_unclear.map(slimCard),
    excluded_sample: view.excluded_sample.slice(0, 30),
    missing_information: view.missing_information,
    sources: view.sources,
  };
}
