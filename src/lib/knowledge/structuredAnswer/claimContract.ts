/**
 * Claim contract helpers — confidence, source types, phrasing.
 */
import type { ClaimStrength, VerifiedClaim } from "@/lib/knowledge/askOrchestration/claimVerifier";
import { phraseClaim } from "@/lib/knowledge/askOrchestration/claimVerifier";
import type { StructuredClaim, ClaimStatus } from "./types";

export function confidenceForStatus(status: ClaimStatus): number {
  switch (status) {
    case "AUTHORITATIVE":
      return 0.95;
    case "CODE_DERIVED":
      return 0.8;
    case "INFERRED":
      return 0.55;
    case "UNSUPPORTED":
      return 0;
  }
}

export function sourceTypesForStrength(
  strength: ClaimStrength,
  hints?: string[],
): string[] {
  if (hints?.length) return [...new Set(hints)];
  switch (strength) {
    case "AUTHORITATIVE":
      return ["canonical", "knowledge_graph"];
    case "CODE_DERIVED":
      return ["code_unit", "analysis_cache"];
    case "INFERRED":
      return ["graph_edge"];
    default:
      return [];
  }
}

export function toStructuredClaim(
  claim: VerifiedClaim,
  extras?: {
    evidence_ids?: string[];
    source_types?: string[];
  },
): StructuredClaim | null {
  if (!claim.kept || claim.strength === "UNSUPPORTED") return null;
  const phrased = phraseClaim(claim);
  if (!phrased) return null;
  const status = claim.strength as ClaimStatus;
  return {
    claim_text: phrased,
    claim_status: status,
    evidence_ids: extras?.evidence_ids ?? [],
    confidence: confidenceForStatus(status),
    source_types: sourceTypesForStrength(status, extras?.source_types),
  };
}

/** Normalize / drop technical junk entity names. */
export function isDisplayableEntityName(name: string): boolean {
  const t = name.trim();
  if (!t) return false;
  if (t === "Ø" || t === "∅" || t === "?" || t === "-") return false;
  if (/^[|\s∅Ø]+$/.test(t)) return false;
  if (t.length < 2) return false;
  // Empty fragments from pipe IDs
  if (/^\|+$/.test(t)) return false;
  return true;
}

export function cleanEntityName(name: string): string {
  return name
    .replace(/\u2205/g, "") // ∅
    .replace(/Ø/g, "")
    .replace(/\|\s*$/g, "")
    .replace(/^\s*\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
