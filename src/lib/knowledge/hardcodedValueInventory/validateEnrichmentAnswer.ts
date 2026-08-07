/**
 * Validate / repair OpenAI enrichment against prepared Datenbasis evidence.
 * Fail closed on invented master data, unknown objects, empty fluff.
 */
import type { MaterialEvidencePack } from "./prepareHardcodedEvidence";

export type RawEnrichmentItem = {
  material_number: string;
  process_label: string | null;
  condition_summary: string | null;
  effect_summary: string | null;
  process_claim_status: "CODE_DERIVED" | "INFERRED" | "UNSUPPORTED";
  primary_object: string | null;
  grounded_on: Array<"snippet" | "analysis" | "mara" | "object_name">;
};

export type ValidatedEnrichmentItem = RawEnrichmentItem & {
  accepted: boolean;
  repair_notes: string[];
};

function matKey(s: string): string {
  const t = s.trim();
  if (/^\d+$/.test(t)) return t.replace(/^0+/, "") || "0";
  return t.toUpperCase();
}

const FLUFF_RE =
  /\b(verwendung im matnr|matnr-kontext|nicht eindeutig|keine angabe|unbekannt)\b/i;

const FORBIDDEN_MASTER_RE =
  /\b(bezeichnung|kurztext|maktx|heißt|genannt|artikelname|produktname)\b/i;

function normalizeStatus(
  pack: MaterialEvidencePack,
  raw: RawEnrichmentItem,
): RawEnrichmentItem["process_claim_status"] {
  if (raw.process_claim_status === "UNSUPPORTED") return "UNSUPPORTED";
  if (pack.has_cached_analysis && raw.grounded_on.includes("analysis")) {
    return "CODE_DERIVED";
  }
  if (raw.grounded_on.includes("snippet") || pack.code_hits.length > 0) {
    return raw.process_claim_status === "CODE_DERIVED"
      ? pack.has_cached_analysis
        ? "CODE_DERIVED"
        : "INFERRED"
      : raw.process_claim_status;
  }
  return "INFERRED";
}

function objectAllowed(
  pack: MaterialEvidencePack,
  primary: string | null,
): boolean {
  if (!primary || !primary.trim()) return true;
  const p = primary.trim().toUpperCase();
  return pack.allowed_object_names.some(
    (o) =>
      o.toUpperCase() === p ||
      p.startsWith(o.toUpperCase()) ||
      o.toUpperCase().startsWith(p),
  );
}

/**
 * Validate one LLM item against its evidence pack.
 */
export function validateEnrichmentItem(
  pack: MaterialEvidencePack,
  raw: RawEnrichmentItem,
): ValidatedEnrichmentItem {
  const notes: string[] = [];
  let process_label = raw.process_label?.trim() || null;
  let condition_summary = raw.condition_summary?.trim() || null;
  let effect_summary = raw.effect_summary?.trim() || null;
  let status = raw.process_claim_status;
  let grounded_on = [...new Set(raw.grounded_on)];
  let primary_object = raw.primary_object?.trim() || null;

  if (matKey(raw.material_number) !== matKey(pack.material_number)) {
    notes.push("material_number_mismatch");
    return {
      ...raw,
      process_label: null,
      condition_summary: null,
      effect_summary: null,
      process_claim_status: "UNSUPPORTED",
      accepted: false,
      repair_notes: notes,
    };
  }

  if (!objectAllowed(pack, primary_object)) {
    notes.push("primary_object_not_in_evidence");
    primary_object = pack.allowed_object_names[0] ?? null;
  }

  // Invented material description without MAKT
  for (const field of [process_label, condition_summary, effect_summary]) {
    if (field && FORBIDDEN_MASTER_RE.test(field) && !pack.master_data.found_in_mara) {
      notes.push("forbidden_master_wording");
    }
    if (
      field &&
      FORBIDDEN_MASTER_RE.test(field) &&
      pack.master_data.found_in_mara &&
      /bezeichnung|kurztext|maktx|heißt|genannt/i.test(field)
    ) {
      // MAKT missing even when MARA found
      notes.push("makt_invented");
      if (process_label && FORBIDDEN_MASTER_RE.test(process_label)) {
        process_label = process_label.replace(FORBIDDEN_MASTER_RE, "").trim() || null;
      }
    }
  }

  // Invented MTART/MATKL not in pack
  if (process_label || effect_summary || condition_summary) {
    const text = `${process_label ?? ""} ${effect_summary ?? ""} ${condition_summary ?? ""}`;
    const mtartMention = text.match(/\b(HAWA|FERT|ROH|HALB|DIEN|HIBE|NLAG|VERP)\b/i);
    if (
      mtartMention &&
      pack.master_data.mtart &&
      mtartMention[1]!.toUpperCase() !== pack.master_data.mtart.toUpperCase()
    ) {
      notes.push("mtart_mismatch");
    }
    if (mtartMention && !pack.master_data.mtart) {
      notes.push("mtart_without_mara");
      // strip risky claim → downgrade
      status = "INFERRED";
    }
  }

  if (process_label && FLUFF_RE.test(process_label)) {
    notes.push("fluff_process");
    process_label = null;
  }
  if (effect_summary && FLUFF_RE.test(effect_summary) && effect_summary.length < 40) {
    notes.push("fluff_effect");
    effect_summary = null;
  }

  if (!grounded_on.length) {
    grounded_on = pack.has_cached_analysis
      ? ["analysis", "snippet"]
      : ["snippet"];
    notes.push("grounded_on_filled");
  }

  if (pack.has_cached_analysis && !grounded_on.includes("analysis")) {
    grounded_on.push("analysis");
  }
  if (pack.master_data.found_in_mara && !grounded_on.includes("mara")) {
    // only if LLM mentioned master attrs
    const text = `${process_label ?? ""} ${condition_summary ?? ""}`;
    if (/\b(MTART|MATKL|MEINS|HAWA|Materialart|Warengruppe)\b/i.test(text)) {
      grounded_on.push("mara");
    }
  }

  status = normalizeStatus(pack, {
    ...raw,
    process_label,
    condition_summary,
    effect_summary,
    process_claim_status: status,
    grounded_on,
    primary_object,
  });

  // Must have at least condition or process for acceptance
  const accepted =
    status !== "UNSUPPORTED" &&
    Boolean(process_label || condition_summary) &&
    pack.code_hits.length > 0;

  if (!accepted) {
    notes.push("rejected_insufficient");
  }

  return {
    material_number: pack.material_number,
    process_label,
    condition_summary,
    effect_summary,
    process_claim_status: accepted ? status : "UNSUPPORTED",
    primary_object,
    grounded_on,
    accepted,
    repair_notes: notes,
  };
}

export function validateEnrichmentBatch(
  packs: MaterialEvidencePack[],
  items: RawEnrichmentItem[],
): ValidatedEnrichmentItem[] {
  const byKey = new Map<string, RawEnrichmentItem>();
  for (const item of items) {
    byKey.set(matKey(item.material_number), item);
  }
  return packs.map((pack) => {
    const raw = byKey.get(matKey(pack.material_number));
    if (!raw) {
      return {
        material_number: pack.material_number,
        process_label: null,
        condition_summary: null,
        effect_summary: null,
        process_claim_status: "UNSUPPORTED" as const,
        primary_object: null,
        grounded_on: [],
        accepted: false,
        repair_notes: ["missing_from_llm"],
      };
    }
    return validateEnrichmentItem(pack, raw);
  });
}
