/**
 * Exact authoritative inventory hits for Direct-RAG.
 * Generic — no object-/customer-specific vocabulary.
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";

/** Inventory / config object types that define what a technical id *is*. */
const AUTHORITATIVE_OBJECT_TYPES = new Set(
  [
    "output_type",
    "output_type_text",
    "output_processing",
    "message_type",
    "ale_message_type",
    "ale_message_type_text",
    "idoc_type",
    "idoc_type_text",
    "partner_profile",
    "logical_system",
    "message_type_idoc_assignment",
    "process_code_function",
    "port",
    "table_field",
    "table",
    "table_profile",
    "enrichment", // synthetic seed enrichment packs are authoritative field inventory
  ].map((s) => s.toLowerCase()),
);

const AUTHORITATIVE_KUT = new Set(
  [
    "message_idoc_object",
    "master_field",
    "table_profile",
    "table_row",
  ].map((s) => s.toLowerCase()),
);

function upper(s: string): string {
  return s.trim().toUpperCase();
}

/** True when `haystack` equals `anchor` or contains it as a structured id segment. */
export function identifierExactMatch(haystack: string, anchor: string): boolean {
  const h = upper(haystack);
  const a = upper(anchor);
  if (!h || !a || a.length < 2) return false;
  if (h === a) return true;
  // Inventory title forms: "output_type: ZECD", "partner_profile: OCTOPUS"
  if (h.endsWith(`: ${a}`) || h.endsWith(`:${a}`)) return true;
  // Path / compound identifiers only — not free-prose space tokenization
  // (avoids "Kampagnen der Edeka" matching anchor EDEKA).
  if (/[|\/]/.test(h) || (h.includes("-") && /[A-Z0-9]-[A-Z0-9]/.test(h))) {
    const parts = h.split(/[|:\/\-]+/).filter(Boolean);
    if (parts.includes(a)) return true;
  }
  return false;
}

export function isAuthoritativeInventoryType(hit: {
  object_type?: string | null;
  knowledge_unit_type?: string | null;
}): boolean {
  const ot = String(hit.object_type ?? "").toLowerCase();
  const kut = String(hit.knowledge_unit_type ?? "").toLowerCase();
  if (kut === "code_unit") return false;
  if (AUTHORITATIVE_OBJECT_TYPES.has(ot)) return true;
  if (AUTHORITATIVE_KUT.has(kut) && ot !== "class" && ot !== "program") {
    return true;
  }
  return false;
}

/** SAP-like technical id tokens only (exclude long soft words e.g. KOMMUNIKATION). */
export function isTechnicalIdToken(anchor: string): boolean {
  const u = anchor.trim().toUpperCase();
  if (u.length < 2 || u.length > 40) return false;
  if (!/^[A-Z][A-Z0-9_|-]*$/.test(u)) return false;
  if (/[_0-9]/.test(u)) return true;
  if (u.startsWith("Z") && u.length >= 3) return true;
  // Short all-caps / alphanumeric ids (OCTOPUS, DESADV, …)
  if (u.length <= 10) return true;
  return false;
}

/**
 * Hit is an exact match of a technical query identifier against an
 * authoritative inventory/config document (definition), not mere code usage.
 */
export function isExactAuthoritativeHit(
  hit: KnowledgeHit,
  technicalAnchors: string[],
): boolean {
  if (technicalAnchors.length === 0) return false;
  if (!isAuthoritativeInventoryType(hit)) return false;
  if (hit.metadata?.exact_authoritative === true) {
    // Still require at least one technical id token in anchors for safety when
    // metadata was copied; prefer live re-check below when possible.
  }

  const fields = [
    hit.object_name,
    hit.subobject_name,
    hit.title,
    hit.source_key,
  ].filter(Boolean) as string[];

  const anchors = technicalAnchors.filter(isTechnicalIdToken);
  if (anchors.length === 0) return false;

  for (const anchor of anchors) {
    for (const field of fields) {
      if (identifierExactMatch(field, anchor)) return true;
    }
    if (
      hit.object_name &&
      hit.subobject_name &&
      identifierExactMatch(`${hit.object_name}-${hit.subobject_name}`, anchor)
    ) {
      return true;
    }
  }
  return false;
}

/** Mark matching hits in-place via metadata.exact_authoritative. */
export function markExactAuthoritativeHits(
  hits: KnowledgeHit[],
  technicalAnchors: string[],
): KnowledgeHit[] {
  const anchors = technicalAnchors
    .map((a) => a.trim())
    .filter((a) => a.length >= 2);
  if (anchors.length === 0) return hits;
  return hits.map((h) => {
    if (!isExactAuthoritativeHit(h, anchors)) return h;
    return {
      ...h,
      metadata: { ...h.metadata, exact_authoritative: true },
      matched_terms: [
        ...new Set([...(h.matched_terms ?? []), "exact_authoritative"]),
      ],
    };
  });
}

export function hasExactAuthoritativeFlag(hit: KnowledgeHit): boolean {
  if (hit.metadata?.exact_authoritative === true) return true;
  return (hit.matched_terms ?? []).some(
    (t) => String(t).toLowerCase() === "exact_authoritative",
  );
}
