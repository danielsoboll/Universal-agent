/**
 * Claim verifier — classify statements before output.
 * UNSUPPORTED is dropped; INFERRED must be phrased as Ableitung.
 */
export type ClaimStrength =
  | "AUTHORITATIVE"
  | "CODE_DERIVED"
  | "INFERRED"
  | "UNSUPPORTED";

export type VerifiedClaim = {
  text: string;
  strength: ClaimStrength;
  kept: boolean;
  reason: string;
};

const EXISTENCE_AS_TYPE_RE =
  /\b(ist\s+(eine?|der|die|das)\s+(output[\s-]?type|ausgabeart|nachrichtenart|message[\s-]?type|idoc[\s-]?typ|tabelle|klasse|programm))\b/i;

const OVERCLAIM_RE =
  /\b(immer|garantiert|vollständig\s+alle|einzigste|die\s+einzige)\b/i;

export function classifyClaimStrength(params: {
  text: string;
  has_authoritative_object_evidence: boolean;
  has_code_evidence: boolean;
  has_graph_edge: boolean;
  from_deterministic_enumeration: boolean;
}): ClaimStrength {
  const t = params.text.trim();
  if (!t) return "UNSUPPORTED";

  if (params.from_deterministic_enumeration) {
    return "AUTHORITATIVE";
  }

  if (EXISTENCE_AS_TYPE_RE.test(t)) {
    return params.has_authoritative_object_evidence
      ? "AUTHORITATIVE"
      : "UNSUPPORTED";
  }

  if (params.has_authoritative_object_evidence && params.has_graph_edge) {
    return "AUTHORITATIVE";
  }
  if (params.has_code_evidence) {
    return OVERCLAIM_RE.test(t) ? "INFERRED" : "CODE_DERIVED";
  }
  if (params.has_graph_edge) {
    return "INFERRED";
  }
  if (OVERCLAIM_RE.test(t)) return "UNSUPPORTED";
  // Soft descriptive claims without evidence stay unsupported
  return "UNSUPPORTED";
}

export function phraseClaim(claim: VerifiedClaim): string | null {
  if (!claim.kept) return null;
  if (claim.strength === "INFERRED") {
    if (/^ableitung:/i.test(claim.text)) return claim.text;
    return `Ableitung: ${claim.text}`;
  }
  return claim.text;
}

export function verifyClaims(
  drafts: Array<{
    text: string;
    has_authoritative_object_evidence?: boolean;
    has_code_evidence?: boolean;
    has_graph_edge?: boolean;
    from_deterministic_enumeration?: boolean;
  }>,
): { kept: VerifiedClaim[]; discarded: VerifiedClaim[] } {
  const kept: VerifiedClaim[] = [];
  const discarded: VerifiedClaim[] = [];
  for (const d of drafts) {
    const strength = classifyClaimStrength({
      text: d.text,
      has_authoritative_object_evidence: Boolean(
        d.has_authoritative_object_evidence,
      ),
      has_code_evidence: Boolean(d.has_code_evidence),
      has_graph_edge: Boolean(d.has_graph_edge),
      from_deterministic_enumeration: Boolean(d.from_deterministic_enumeration),
    });
    const claim: VerifiedClaim = {
      text: d.text,
      strength,
      kept: strength !== "UNSUPPORTED",
      reason:
        strength === "UNSUPPORTED"
          ? "keine autoritative/code/graph Evidenz"
          : strength,
    };
    if (claim.kept) kept.push(claim);
    else discarded.push(claim);
  }
  return { kept, discarded };
}
