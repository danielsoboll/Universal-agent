/**
 * Deterministically resolve which Nachrichten-Anwendung (KAPPL) covers
 * Lieferungen / Versand — from output-type texts, not hardcoded V2.
 * Result is a heuristic with explicit confidence — never a hard fact.
 */
import type {
  LoadedOutputText,
  LoadedOutputType,
} from "./loadMessageIdocInventory";
import type {
  ApplicationSelection,
  ApplicationSelectionConfidence,
} from "./types";

const DELIVERY_TEXT_RE =
  /\b(lief|versand|avis|shipping|delivery|desadv|umlager)/i;

export type DeliveryApplicationResolution = {
  application: string | null;
  reason: string;
  selection: ApplicationSelection;
  scores: Array<{
    application: string;
    delivery_text_hits: number;
    total_texts: number;
    output_type_count: number;
    score: number;
  }>;
};

function confidenceFor(params: {
  hits: number;
  total: number;
  score: number;
  secondScore: number;
}): ApplicationSelectionConfidence {
  const ratio = params.total > 0 ? params.hits / params.total : 0;
  const gap = params.score - params.secondScore;
  if (params.hits >= 10 && ratio >= 0.35 && gap >= 50) return "HIGH";
  if (params.hits >= 5 && ratio >= 0.2) return "MEDIUM";
  return "LOW";
}

export function resolveDeliveryApplication(params: {
  output_types: LoadedOutputType[];
  texts: LoadedOutputText[];
}): DeliveryApplicationResolution {
  const byAppTexts = new Map<string, LoadedOutputText[]>();
  for (const t of params.texts) {
    const list = byAppTexts.get(t.application) ?? [];
    list.push(t);
    byAppTexts.set(t.application, list);
  }

  const otCount = new Map<string, number>();
  for (const o of params.output_types) {
    otCount.set(o.application, (otCount.get(o.application) ?? 0) + 1);
  }

  const scores: DeliveryApplicationResolution["scores"] = [];
  for (const [application, texts] of byAppTexts) {
    const de = texts.filter((t) => t.language === "DE" || t.language === "D");
    const pool = de.length > 0 ? de : texts;
    const hitTypes = new Set<string>();
    for (const t of pool) {
      if (DELIVERY_TEXT_RE.test(t.text)) hitTypes.add(t.output_type);
    }
    const delivery_text_hits = hitTypes.size;
    const total_texts = new Set(pool.map((t) => t.output_type)).size;
    const output_type_count = otCount.get(application) ?? 0;
    const ratio = total_texts > 0 ? delivery_text_hits / total_texts : 0;
    const score =
      delivery_text_hits * 100 +
      ratio * 20 +
      Math.min(output_type_count, 50) * 0.01;
    scores.push({
      application,
      delivery_text_hits,
      total_texts,
      output_type_count,
      score,
    });
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const second = scores[1];

  if (!best || best.delivery_text_hits <= 0) {
    const selection: ApplicationSelection = {
      selected_application: null,
      selection_method: "output_type_text_delivery_density",
      score: 0,
      matching_text_count: 0,
      total_text_count: 0,
      confidence: "LOW",
      reason:
        "Keine Anwendung mit Liefer-/Versand-Texten in Outputart-Beschreibungen gefunden",
    };
    return {
      application: null,
      reason: selection.reason,
      selection,
      scores,
    };
  }

  const confidence = confidenceFor({
    hits: best.delivery_text_hits,
    total: best.total_texts,
    score: best.score,
    secondScore: second?.score ?? 0,
  });

  const reason = `${best.application} wurde anhand der vorhandenen Outputart-Texte als wahrscheinlichste Lieferanwendung ermittelt (${best.delivery_text_hits}/${best.total_texts} Texte mit Liefer-/Versand-Bezug; Konfidenz ${confidence}).`;

  const selection: ApplicationSelection = {
    selected_application: best.application,
    selection_method: "output_type_text_delivery_density",
    score: best.score,
    matching_text_count: best.delivery_text_hits,
    total_text_count: best.total_texts,
    confidence,
    reason,
  };

  return {
    application: best.application,
    reason,
    selection,
    scores,
  };
}
