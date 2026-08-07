/**
 * Regression: OUTPUT_TYPE nur bei T685 KVEWE=B; ZRAH≠Output; ZECD=Output.
 *
 *   npx tsx tests/domain/typeAuthorityOutputType.test.ts
 */
import assert from "node:assert/strict";
import {
  isAuthoritativeOutputTypeKvewe,
  messageIdocObjectIsAuthoritativeOutputType,
  mayClaimObjectExistsAsType,
  type TypeProof,
} from "../../src/lib/domain/typeAuthority";

assert.equal(isAuthoritativeOutputTypeKvewe("B"), true);
assert.equal(isAuthoritativeOutputTypeKvewe("A"), false);
assert.equal(isAuthoritativeOutputTypeKvewe(""), false);
assert.equal(isAuthoritativeOutputTypeKvewe(undefined), false);

assert.equal(
  messageIdocObjectIsAuthoritativeOutputType({
    object_type: "output_type",
    attributes: { KVEWE: "B", KAPPL: "V1", KSCHL: "ZECD" },
  }),
  true,
);

assert.equal(
  messageIdocObjectIsAuthoritativeOutputType({
    object_type: "output_type",
    attributes: { KVEWE: "A", KAPPL: "V", KSCHL: "ZRAH" },
  }),
  false,
  "Pricing KVEWE=A must never be OUTPUT_TYPE",
);

assert.equal(
  messageIdocObjectIsAuthoritativeOutputType({
    object_type: "output_type_text",
    attributes: { KVEWE: "A", KSCHL: "ZRAH", VTEXT: "Rahmenzuschlag" },
  }),
  false,
);

const proofsZrah: TypeProof[] = [
  {
    type: "PRICING_CONDITION_TYPE",
    status: "HYPOTHESIS",
    relation: "USER_CONTEXT_OR_CODE_INDICATION",
    confirmed_by_canonical: false,
    reason: "Code/name indication only",
  },
  {
    type: "OUTPUT_TYPE",
    status: "NOT_CONFIRMED",
    relation: "CODE_REFERENCES_SYMBOL",
    confirmed_by_canonical: false,
    reason: "Code reference is not existence",
  },
];
assert.equal(mayClaimObjectExistsAsType(proofsZrah, "OUTPUT_TYPE"), false);

const proofsZecd: TypeProof[] = [
  {
    type: "OUTPUT_TYPE",
    status: "CONFIRMED",
    relation: "OBJECT_EXISTS_AS_TYPE",
    confirmed_by_canonical: true,
    source_table: "T685",
    reason: "T685 KVEWE=B",
  },
];
assert.equal(mayClaimObjectExistsAsType(proofsZecd, "OUTPUT_TYPE"), true);

console.log("typeAuthorityOutputType.test.ts OK");
