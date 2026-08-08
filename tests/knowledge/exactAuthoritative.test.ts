/**
 *   npx tsx tests/knowledge/exactAuthoritative.test.ts
 */
import assert from "assert";
import {
  identifierExactMatch,
  isAuthoritativeInventoryType,
  isExactAuthoritativeHit,
  isTechnicalIdToken,
  markExactAuthoritativeHits,
} from "../../src/lib/knowledge/exactAuthoritative";
import { assessRelevanceGate } from "../../src/lib/knowledge/relevanceGate";
import type { KnowledgeHit } from "../../src/lib/knowledge/types";

function hit(
  id: string,
  opts: Partial<KnowledgeHit> & { title?: string } = {},
): KnowledgeHit {
  return {
    rank: 1,
    search_document_id: id,
    source_key: opts.source_key ?? id,
    title: opts.title ?? id,
    knowledge_unit_type: opts.knowledge_unit_type ?? "message_idoc_object",
    combined_score: 10,
    exact_score: opts.exact_score ?? 3,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.8,
    matched_terms: opts.matched_terms ?? [],
    snippet: opts.snippet ?? opts.title ?? id,
    evidence_refs: [],
    facts: opts.facts ?? [],
    inferences: [],
    metadata: opts.metadata ?? {},
    object_name: opts.object_name ?? "",
    object_type: opts.object_type ?? "",
    subobject_name: opts.subobject_name ?? "",
    technical_summary: opts.technical_summary ?? opts.snippet ?? "",
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: [],
    entities: [],
    relations: [],
    evidence: opts.evidence ?? [],
    doc_confidence: 0.8,
  };
}

assert.ok(identifierExactMatch("LS|OCTOPUS", "OCTOPUS"));
assert.ok(identifierExactMatch("output_type: ZECD", "ZECD"));
assert.ok(!identifierExactMatch("LS|EDIOCTOPUS", "OCTOPUS"));
assert.ok(isTechnicalIdToken("OCTOPUS"));
assert.ok(isTechnicalIdToken("ZECD"));
assert.ok(!isTechnicalIdToken("KOMMUNIKATION"));
assert.ok(isAuthoritativeInventoryType({ object_type: "output_type" }));
assert.ok(isAuthoritativeInventoryType({ object_type: "partner_profile" }));
assert.ok(
  !isAuthoritativeInventoryType({
    knowledge_unit_type: "code_unit",
    object_type: "CLASS",
  }),
);

const output = hit("out_zecd", {
  title: "output_type: ZECD",
  object_name: "ZECD",
  object_type: "output_type",
  snippet: "output_type: ZECD",
  technical_summary: "output_type: ZECD",
});
assert.ok(isExactAuthoritativeHit(output, ["ZECD"]));

const partner = hit("pp_oct", {
  title: "partner_profile: OCTOPUS",
  object_name: "LS|OCTOPUS",
  object_type: "partner_profile",
  snippet: "partner_profile: OCTOPUS",
  technical_summary: "partner_profile: OCTOPUS",
});
assert.ok(isExactAuthoritativeHit(partner, ["OCTOPUS", "KOMMUNIKATION"]));

const softText = hit("komm", {
  title: "ale_message_type_text: Interne Kommunikation zwischen MM und ICH",
  object_name: "…",
  object_type: "ale_message_type_text",
  snippet:
    "ale_message_type_text: Interne Kommunikation zwischen MM und ICH",
  technical_summary:
    "ale_message_type_text: Interne Kommunikation zwischen MM und ICH",
});
assert.ok(
  !isExactAuthoritativeHit(softText, ["OCTOPUS", "KOMMUNIKATION"]),
  "long soft word must not make Kommunikation-texts exact_authoritative",
);

const marked = markExactAuthoritativeHits(
  [output, partner, softText],
  ["ZECD", "OCTOPUS", "KOMMUNIKATION"],
);
assert.strictEqual(marked[0]!.metadata.exact_authoritative, true);
assert.strictEqual(marked[1]!.metadata.exact_authoritative, true);
assert.ok(!marked[2]!.metadata.exact_authoritative);

const code = hit("code_zecd", {
  title: "CLASS / ZCL_AUMO_ATP / METHOD / CHECK_ZECD_CAN_BE_SENT",
  object_name: "CHECK_ZECD_CAN_BE_SENT",
  object_type: "CLASS",
  knowledge_unit_type: "code_unit",
  snippet: "CLASS / ZCL_AUMO_ATP / METHOD / CHECK_ZECD_CAN_BE_SENT",
  technical_summary: "CLASS / ZCL_AUMO_ATP / METHOD / CHECK_ZECD_CAN_BE_SENT",
});

const gate = assessRelevanceGate({
  question: "Was wissen wir über ZECD?",
  hits: [code, output],
});
assert.ok(
  gate.supporting_source_ids.includes("out_zecd"),
  `output_type must stay supporting: ${JSON.stringify(gate)}`,
);

const gateOct = assessRelevanceGate({
  question: "Wie funktioniert die Kommunikation mit OCTOPUS?",
  hits: [partner, softText],
});
assert.ok(
  gateOct.supporting_source_ids.includes("pp_oct"),
  `partner_profile OCTOPUS must stay supporting: ${JSON.stringify(gateOct)}`,
);

console.log("exactAuthoritative.test.ts OK");
