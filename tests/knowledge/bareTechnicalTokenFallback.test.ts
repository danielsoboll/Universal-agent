/**
 *   npx tsx tests/knowledge/bareTechnicalTokenFallback.test.ts
 */
import assert from "assert";
import {
  buildUsageOnlyDirectAnswer,
  isBareTechnicalFallbackToken,
  isBareTechnicalUsageHit,
  selectBareTechnicalFallbackTokens,
  shouldUseUsageOnlyAnswer,
  tokensNeedingUsageFallback,
} from "../../src/lib/knowledge/bareTechnicalTokenFallback";
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
    knowledge_unit_type: opts.knowledge_unit_type ?? "code_unit",
    combined_score: 10,
    exact_score: opts.exact_score ?? 3,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.8,
    matched_terms: opts.matched_terms ?? ["bare_technical_usage", "literal:ZRAH"],
    snippet: opts.snippet ?? "kschl = 'ZRAH'.",
    evidence_refs: opts.evidence_refs ?? ["L10"],
    facts: opts.facts ?? [],
    inferences: [],
    metadata: opts.metadata ?? { portable_literal: true, bare_technical_usage: true },
    object_name: opts.object_name ?? "Z_RVADIN01",
    object_type: opts.object_type ?? "PROGRAM",
    subobject_name: opts.subobject_name ?? "ZRAH_LEERGUT_ITEM_PRINT",
    technical_summary: opts.technical_summary ?? opts.snippet ?? "",
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: opts.hardcoded_values ?? ["ZRAH"],
    entities: [],
    relations: [],
    evidence: opts.evidence ?? [
      { statement_type: "fact", text: "kschl = 'ZRAH'.", lines: [] },
    ],
    doc_confidence: 0.8,
  };
}

assert.ok(isBareTechnicalFallbackToken("ZRAH"));
assert.ok(isBareTechnicalFallbackToken("ZZ_VLAGER"));
assert.ok(!isBareTechnicalFallbackToken("KOMMUNIKATION"));
assert.ok(!isBareTechnicalFallbackToken("LAGER"));
assert.ok(!isBareTechnicalFallbackToken("OCTOPUS")); // inventory path, not bare-Z fallback
assert.ok(!isBareTechnicalFallbackToken("wissen"));

const selected = selectBareTechnicalFallbackTokens(
  ["ZRAH", "OCTOPUS", "LAGER"],
  (t) => t.toUpperCase() === "OCTOPUS",
);
assert.deepStrictEqual(selected, ["ZRAH"]);

const usage = hit("lit1");
assert.ok(isBareTechnicalUsageHit(usage));

const needing = tokensNeedingUsageFallback({
  tokens: ["ZRAH"],
  existingHits: [],
});
assert.deepStrictEqual(needing, ["ZRAH"]);

const notNeeding = tokensNeedingUsageFallback({
  tokens: ["ZRAH"],
  existingHits: [usage],
});
assert.deepStrictEqual(notNeeding, []);

const ans = buildUsageOnlyDirectAnswer({
  anchor: "ZRAH",
  hits: [usage],
});
assert.ok(ans.includes("authoritative Definition"));
assert.ok(ans.includes("Z_RVADIN01"));
assert.ok(ans.includes("ZRAH"));
assert.ok(!/Output-Type|Nachrichtentyp|ist ein /i.test(ans));

const decision = shouldUseUsageOnlyAnswer({
  hits: [usage],
  technicalAnchors: ["ZRAH"],
});
assert.equal(decision.apply, true);
assert.equal(decision.anchor, "ZRAH");

const auth = hit("out", {
  title: "output_type: ZECD",
  object_name: "ZECD",
  object_type: "output_type",
  knowledge_unit_type: "message_idoc_object",
  snippet: "output_type: ZECD",
  hardcoded_values: [],
  matched_terms: ["exact_authoritative"],
  metadata: { exact_authoritative: true },
});
assert.equal(
  shouldUseUsageOnlyAnswer({
    hits: [auth],
    technicalAnchors: ["ZECD"],
  }).apply,
  false,
);

const gate = assessRelevanceGate({
  question: "Was ist ZRAH?",
  hits: [usage],
  grounding: {
    query_entities: [
      {
        query_entity: "ZRAH",
        entity_type: "identifier",
        normalized_query_entity: "zrah",
      },
    ],
    results: [
      {
        query_entity: "ZRAH",
        entity_type: "identifier",
        grounding_status: "confirmed",
        matched_source_entities: ["ZRAH"],
        evidence_refs: ["#1"],
        reason: "ok",
      },
    ],
    has_ungrounded_named_entity: false,
    has_ungrounded_technical_anchor: false,
    ungrounded_technical_anchors: [],
    grounded_entity_names: ["ZRAH"],
    contradicted_entity_names: [],
  },
});
assert.ok(
  gate.answerability === "answerable" ||
    gate.answerability === "partially_answerable",
  gate.reason,
);
assert.ok(gate.supporting_source_ids.includes("lit1"));

console.log("bareTechnicalTokenFallback.test.ts: ok");
