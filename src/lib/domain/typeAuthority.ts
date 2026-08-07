/**
 * Authoritative type proofs — existence vs usage.
 *
 * OBJECT_EXISTS_AS_TYPE may only be claimed from authoritative canonical sources.
 * Code/literal/config-read hits are usage evidence only.
 */
export type AuthoritativeObjectType =
  | "OUTPUT_TYPE"
  | "OUTPUT_TYPE_TEXT"
  | "MESSAGE_TYPE"
  | "IDOC_TYPE"
  | "CONDITION_TYPE"
  | "PRICING_CONDITION_TYPE"
  | "TABLE"
  | "FIELD"
  | "PROGRAM"
  | "FUNCTION_MODULE"
  | "METHOD"
  | "FORM_ROUTINE";

export type ExistenceRelation = "OBJECT_EXISTS_AS_TYPE";

export type UsageRelation =
  | "CODE_REFERENCES_SYMBOL"
  | "CODE_USES_LITERAL"
  | "CODE_READS_CONFIGURATION"
  | "PROGRAM_IS_ASSIGNED_TO_OUTPUT_TYPE"
  | "PROGRAM_CALCULATES_OR_PRINTS_CONDITION";

/**
 * SAP T685 KVEWE: only "B" (Nachrichtensteuerung) is an Output Type usage.
 * "A" = Pricing, other values = other condition usages — never OUTPUT_TYPE.
 */
export const OUTPUT_TYPE_AUTHORITATIVE_KVEWE = "B" as const;

export function isAuthoritativeOutputTypeKvewe(
  kvewe: string | null | undefined,
): boolean {
  return String(kvewe ?? "").trim().toUpperCase() === OUTPUT_TYPE_AUTHORITATIVE_KVEWE;
}

/** Message-idoc canonical object_type + attributes → may claim OUTPUT_TYPE existence? */
export function messageIdocObjectIsAuthoritativeOutputType(params: {
  object_type: string;
  attributes?: Record<string, unknown> | null;
}): boolean {
  const ot = params.object_type.trim().toLowerCase();
  if (ot !== "output_type" && ot !== "output_type_text") return false;
  const kvewe = params.attributes?.KVEWE;
  return isAuthoritativeOutputTypeKvewe(
    typeof kvewe === "string" ? kvewe : String(kvewe ?? ""),
  );
}

export type TypeProof = {
  type: AuthoritativeObjectType | string;
  status: "CONFIRMED" | "HYPOTHESIS" | "USAGE_ONLY" | "NOT_CONFIRMED";
  relation:
    | ExistenceRelation
    | UsageRelation
    | "USER_CONTEXT_OR_CODE_INDICATION";
  confirmed_by_canonical: boolean;
  source_table?: string;
  source_path?: string;
  reason: string;
};

/**
 * Gate for synthesis: "X is OUTPUT_TYPE" requires authoritative existence proof.
 */
export function mayClaimObjectExistsAsType(proofs: TypeProof[], type: string): boolean {
  const want = type.toUpperCase();
  return proofs.some(
    (p) =>
      p.type.toUpperCase() === want &&
      p.status === "CONFIRMED" &&
      p.relation === "OBJECT_EXISTS_AS_TYPE" &&
      p.confirmed_by_canonical,
  );
}
