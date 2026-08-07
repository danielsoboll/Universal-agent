/**
 * Prepare dense, Datenbasis-backed evidence packs for OpenAI enrichment.
 */
import type { HardcodedMaterialCard } from "./types";
import {
  extractAnalysisHint,
  type AnalysisHint,
} from "./analysisHints";
import {
  loadMaterialMasterHints,
  matnrLookupKey,
  type MaterialMasterHint,
} from "./loadMaterialMasterHints";

export type CodeHitEvidence = {
  source_key: string;
  object_type: string;
  object_name: string;
  unit_name: string;
  line_number: number | null;
  snippet: string;
  condition_hint: string | null;
  action_hint: string | null;
  tables_fields: string[];
  analysis: AnalysisHint | null;
};

export type MaterialEvidencePack = {
  material_number: string;
  occurrence_count: number;
  master_data: {
    found_in_mara: boolean;
    mtart: string | null;
    matkl: string | null;
    meins: string | null;
    spart: string | null;
    note: string;
  };
  code_hits: CodeHitEvidence[];
  allowed_object_names: string[];
  has_cached_analysis: boolean;
  evidence_strength: "STRONG" | "MEDIUM" | "WEAK";
};

export type PreparedHardcodedEvidence = {
  packs: MaterialEvidencePack[];
  mara_hits: number;
  mara_scanned: number;
  analysis_hit_units: number;
  sources: string[];
};

function pickDistinctHits(
  card: HardcodedMaterialCard,
  analyses: Map<string, Record<string, unknown>>,
  maxHits: number,
): CodeHitEvidence[] {
  const active = card.occurrences.filter((o) => o.active_code);
  const pool = active.length ? active : card.occurrences;
  const byLoc = new Map<string, (typeof pool)[0]>();
  for (const o of pool) {
    const loc = `${o.object_name}|${o.unit_name}`;
    if (!byLoc.has(loc)) byLoc.set(loc, o);
  }
  const selected = [...byLoc.values()].slice(0, maxHits);
  return selected.map((o) => {
    const analysis = extractAnalysisHint(analyses.get(o.source_key));
    return {
      source_key: o.source_key,
      object_type: o.object_type,
      object_name: o.object_name,
      unit_name: o.unit_name,
      line_number: o.line_number,
      snippet: o.snippet.slice(0, 280),
      condition_hint: o.condition,
      action_hint: o.action,
      tables_fields: o.tables_fields.slice(0, 6),
      analysis,
    };
  });
}

function strengthOf(pack: Omit<MaterialEvidencePack, "evidence_strength">): MaterialEvidencePack["evidence_strength"] {
  const withAnalysis = pack.code_hits.filter((h) => h.analysis).length;
  if (withAnalysis >= 1 && pack.code_hits.length >= 1) return "STRONG";
  if (pack.code_hits.length >= 2) return "MEDIUM";
  return "WEAK";
}

function masterBlock(hint: MaterialMasterHint | undefined): MaterialEvidencePack["master_data"] {
  if (!hint || !hint.found) {
    return {
      found_in_mara: false,
      mtart: null,
      matkl: null,
      meins: null,
      spart: null,
      note: "Materialnummer nicht in MARA-Stammdaten der Datenbasis gefunden (oder nur Code-Literal).",
    };
  }
  return {
    found_in_mara: true,
    mtart: hint.mtart,
    matkl: hint.matkl,
    meins: hint.meins,
    spart: hint.spart,
    note: "Stammdaten aus MARA. Materialkurztext (MAKT) ist in dieser Datenbasis nicht exportiert — keine Bezeichnung erfinden.",
  };
}

/**
 * Build evidence packs for priority material cards.
 */
export async function prepareHardcodedEvidence(params: {
  projectKey: string;
  cards: HardcodedMaterialCard[];
  analyses: Map<string, Record<string, unknown>>;
  maxHitsPerMaterial?: number;
}): Promise<PreparedHardcodedEvidence> {
  const maxHits = params.maxHitsPerMaterial ?? 5;
  const mara = await loadMaterialMasterHints({
    projectKey: params.projectKey,
    materialNumbers: params.cards.map((c) => c.material_number),
  });

  let analysis_hit_units = 0;
  const packs: MaterialEvidencePack[] = [];

  for (const card of params.cards) {
    const code_hits = pickDistinctHits(card, params.analyses, maxHits);
    analysis_hit_units += code_hits.filter((h) => h.analysis).length;
    const master = masterBlock(mara.byKey.get(matnrLookupKey(card.material_number)));
    const allowed_object_names = [
      ...new Set(code_hits.map((h) => h.object_name)),
    ];
    const base = {
      material_number: card.material_number,
      occurrence_count: card.occurrence_count,
      master_data: master,
      code_hits,
      allowed_object_names,
      has_cached_analysis: code_hits.some((h) => h.analysis),
    };
    packs.push({
      ...base,
      evidence_strength: strengthOf(base),
    });
  }

  return {
    packs,
    mara_hits: mara.hits,
    mara_scanned: mara.scanned,
    analysis_hit_units,
    sources: [
      "canonical/master-data/materials/MARA/content.jsonl",
      "analyses/classes/unit_analyses.jsonl",
      "canonical code_units (snippets from scan)",
    ],
  };
}
