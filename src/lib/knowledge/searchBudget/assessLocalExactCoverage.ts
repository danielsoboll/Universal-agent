/**
 * Assess LOCAL_EXACT coverage from existing index/canonical hits (no OpenAI).
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";
import {
  COMMUNICATION_OBJECT_TYPES,
  type CommunicationObjectType,
} from "./types";

const COMM_SET = new Set<string>(COMMUNICATION_OBJECT_TYPES);

function upper(s: string): string {
  return s.toUpperCase();
}

function hitHaystack(hit: KnowledgeHit): string {
  return upper(
    [
      hit.title,
      hit.source_key,
      hit.object_name,
      hit.subobject_name,
      hit.object_type,
      hit.snippet,
      ...(hit.matched_terms ?? []),
      ...(hit.entities ?? []).map((e) => e.name),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export function isCommunicationHit(hit: KnowledgeHit): boolean {
  const ot = String(hit.object_type ?? "").toLowerCase();
  if (COMM_SET.has(ot)) return true;
  if (hit.knowledge_unit_type === "message_idoc_object") return true;
  const blob = `${hit.title} ${hit.object_type} ${hit.knowledge_unit_type}`.toLowerCase();
  return (
    /partner.?profil|logical.?system|idoc|message.?type|rfc|webservice|proxy|port\b/.test(
      blob,
    )
  );
}

export function isLocalExactHit(
  hit: KnowledgeHit,
  anchors: string[],
): boolean {
  if (anchors.length === 0) return hit.exact_score > 0;
  const hay = hitHaystack(hit);
  const matchedTerms = (hit.matched_terms ?? []).map((t) => String(t).toUpperCase());
  for (const a of anchors) {
    const n = upper(a);
    if (n.length < 2) continue;
    if (hay.includes(n)) return true;
    if (matchedTerms.some((t) => t === `SYM:${n}` || t.includes(n))) return true;
  }
  return hit.exact_score > 0 && anchors.some((a) => hay.includes(upper(a)));
}

export function hasCachedAnalysisSignal(hit: KnowledgeHit): boolean {
  if (hit.knowledge_unit_type !== "code_unit") return true; // non-code: indexed as-is
  const summary = (hit.technical_summary ?? "").trim();
  const facts = hit.facts?.length ?? 0;
  const evidence = hit.evidence?.length ?? 0;
  return summary.length >= 20 || facts > 0 || evidence > 0;
}

export type LocalExactCoverage = {
  sufficient: boolean;
  local_exact_hits: KnowledgeHit[];
  communication_hits: KnowledgeHit[];
  cache_hits: number;
  missing_code_analysis: KnowledgeHit[];
  reason: string;
};

/**
 * Stage 0: enough exact/canonical/communication evidence to answer without
 * vector search or new code analysis.
 */
export function assessLocalExactCoverage(params: {
  hits: KnowledgeHit[];
  anchors: string[];
  namedEntity: string | null;
}): LocalExactCoverage {
  const anchors = params.anchors.map((a) => a.trim()).filter(Boolean);
  const local_exact_hits = params.hits.filter((h) =>
    isLocalExactHit(h, anchors),
  );
  const communication_hits = local_exact_hits.filter(isCommunicationHit);
  const cache_hits = local_exact_hits.filter(hasCachedAnalysisSignal).length;
  const missing_code_analysis = local_exact_hits.filter(
    (h) => h.knowledge_unit_type === "code_unit" && !hasCachedAnalysisSignal(h),
  );

  // Named / technical anchor with ≥1 exact communication or strong exact hit
  if (anchors.length > 0 && communication_hits.length > 0) {
    return {
      sufficient: true,
      local_exact_hits,
      communication_hits,
      cache_hits,
      missing_code_analysis,
      reason: `LOCAL_EXACT: ${communication_hits.length} Kommunikationsobjekt(e) zum Anker belegt.`,
    };
  }

  if (anchors.length > 0 && local_exact_hits.length >= 1) {
    const top = local_exact_hits[0]!;
    const strong =
      top.exact_score >= 2 ||
      (top.matched_terms ?? []).some((t) => String(t).startsWith("sym:")) ||
      top.knowledge_unit_type === "message_idoc_object" ||
      top.knowledge_unit_type === "master_field";
    if (strong) {
      return {
        sufficient: true,
        local_exact_hits,
        communication_hits,
        cache_hits,
        missing_code_analysis,
        reason: `LOCAL_EXACT: exakter Treffer auf Anker (${top.title || top.source_key}).`,
      };
    }
  }

  if (anchors.length > 0 && local_exact_hits.length === 0) {
    return {
      sufficient: false,
      local_exact_hits,
      communication_hits,
      cache_hits,
      missing_code_analysis,
      reason: params.namedEntity
        ? `Kein exakter Canonical-/Graph-Treffer zu „${params.namedEntity}“.`
        : "Keine exakten Anker-Treffer im lokalen Bestand.",
    };
  }

  return {
    sufficient: false,
    local_exact_hits,
    communication_hits,
    cache_hits,
    missing_code_analysis,
    reason: "LOCAL_EXACT unzureichend — Escalation zu EXISTING_RETRIEVAL.",
  };
}

export function communicationObjectTypeOf(
  hit: KnowledgeHit,
): CommunicationObjectType | null {
  const ot = String(hit.object_type ?? "").toLowerCase();
  if (COMM_SET.has(ot)) return ot as CommunicationObjectType;
  return null;
}

/** Prefer communication objects, then exact, then score. */
export function prioritizeCommunicationHits(
  hits: KnowledgeHit[],
  anchors: string[],
): KnowledgeHit[] {
  const rank = (h: KnowledgeHit): number => {
    let s = 0;
    if (isCommunicationHit(h)) s += 1000;
    if (isLocalExactHit(h, anchors)) s += 400;
    s += Math.min(200, h.exact_score * 40);
    s += Math.min(100, h.combined_score);
    return s;
  };
  return [...hits]
    .sort((a, b) => rank(b) - rank(a))
    .map((h, i) => ({ ...h, rank: i + 1 }));
}
