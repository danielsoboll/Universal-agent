/**
 *   npx tsx tests/knowledge/unresolvedQualifierAndDedup.test.ts
 */
import assert from "assert";
import {
  assessUnresolvedQueryQualifiers,
  hitsMentionQualifier,
} from "../../src/lib/knowledge/unresolvedQueryQualifier";
import {
  canonicalEvidenceIdentity,
  dedupeFinalEvidenceHits,
  dedupeClaimStatements,
} from "../../src/lib/knowledge/dedupeFinalEvidence";
import { assessRelevanceGate } from "../../src/lib/knowledge/relevanceGate";
import type { KnowledgeHit } from "../../src/lib/knowledge/types";
import type { RelevanceGateResult } from "../../src/lib/knowledge/relevanceGate";

function hit(partial: Partial<KnowledgeHit> & { search_document_id: string }): KnowledgeHit {
  return {
    rank: 1,
    source_key: partial.source_key ?? partial.search_document_id,
    title: partial.title ?? partial.object_name ?? "",
    knowledge_unit_type: partial.knowledge_unit_type ?? "code_unit",
    combined_score: partial.combined_score ?? 10,
    exact_score: partial.exact_score ?? 2,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.8,
    matched_terms: [],
    snippet: partial.snippet ?? "",
    evidence_refs: [],
    facts: partial.facts ?? [],
    inferences: [],
    metadata: partial.metadata ?? {},
    object_name: partial.object_name ?? "",
    object_type: partial.object_type ?? "PROGRAM",
    subobject_name: partial.subobject_name ?? "",
    technical_summary: partial.technical_summary ?? "",
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: partial.hardcoded_values ?? [],
    entities: partial.entities ?? [],
    relations: [],
    evidence: [],
    doc_confidence: 0.8,
    ...partial,
  };
}

const gateOk: RelevanceGateResult = {
  answerability: "partially_answerable",
  query_concepts: ["virtuelles", "Lager"],
  matched_concepts: ["virtuelles", "Lager"],
  missing_concepts: ["Pepsi"],
  supporting_source_ids: ["a"],
  contradicting_source_ids: [],
  similar_but_insufficient_source_ids: [],
  reason: "test",
};

const vlagerHit = hit({
  search_document_id: "enrich:knvv",
  knowledge_unit_type: "master_field",
  object_type: "ENRICHMENT",
  object_name: "Enrichment KNVV-ZZ_VLAGER",
  title: "Enrichment KNVV-ZZ_VLAGER",
  snippet: "EDEKA Dömelt VKORG 0100 ZZ_VLAGER=X",
  facts: ["EDEKA Dömelt 0100/01/01=X"],
  metadata: { seed_enrichment: true },
});

const pepsi = assessUnresolvedQueryQualifiers({
  question: "Wie funktioniert das Pepsi virtuelle Lager?",
  hits: [vlagerHit],
  relevanceGate: gateOk,
});
assert.ok(pepsi.apply_partial_framing, "Pepsi + topic → partial framing");
assert.ok(
  pepsi.unresolved.some((u) => /pepsi/i.test(u.raw)),
  "Pepsi unresolved",
);
assert.ok(pepsi.disclaimer && /Pepsi/i.test(pepsi.disclaimer));

const edeka = assessUnresolvedQueryQualifiers({
  question: "Wie funktioniert das Edeka virtuelle Lager?",
  hits: [vlagerHit],
  relevanceGate: gateOk,
});
assert.ok(!edeka.apply_partial_framing, "Edeka is evidenced → no unresolved framing");
assert.ok(edeka.resolved.some((u) => /edeka/i.test(u.raw)));
assert.ok(hitsMentionQualifier([vlagerHit], "edeka"));

// Query-side matched_terms must NOT count as qualifier evidence.
const falseSym = hit({
  search_document_id: "x",
  object_name: "ZZTVAG",
  title: "Tabellenprofil ZZTVAG",
  matched_terms: ["sym:pepsi", "config_table_expansion"],
  snippet: "ZZ_VLAGER=X",
});
assert.ok(
  !hitsMentionQualifier([falseSym], "pepsi"),
  "sym:pepsi matched_terms is not content evidence",
);

// Phrase coverage: virtuelles Lager without brand qualifier must not fail on Lager.
{
  const gate = assessRelevanceGate({
    question: "Wie funktioniert das virtuelle Lager?",
    hits: [vlagerHit],
  });
  assert.notEqual(
    gate.answerability,
    "insufficient",
    `bare VLAGER must not be insufficient (${gate.reason})`,
  );
  assert.ok(
    gate.matched_concepts.map((c) => c.toLowerCase()).includes("lager") ||
      !gate.missing_concepts.map((c) => c.toLowerCase()).includes("lager"),
    "Lager must be consumed when ZZ_VLAGER topic evidence exists",
  );
}

// Dedup PROGRAM / CODE_UNIT same object WITHOUT routine → still one entry
const a = hit({
  search_document_id: "p1",
  object_type: "PROGRAM",
  knowledge_unit_type: "code_unit",
  object_name: "Z_RVADIN01",
  exact_score: 4,
  snippet: "program header",
});
const b = hit({
  search_document_id: "p2",
  object_type: "CODE_UNIT",
  knowledge_unit_type: "code_unit",
  object_name: "Z_RVADIN01",
  exact_score: 2,
  snippet: "other unit text",
});
assert.equal(canonicalEvidenceIdentity(a), canonicalEvidenceIdentity(b));
const dedup = dedupeFinalEvidenceHits([a, b]);
assert.equal(dedup.hits.length, 1);
assert.equal(dedup.merged_groups, 1);
assert.equal(dedup.hits[0]!.search_document_id, "p1");

// Literal kschl vs FORM in same program must NOT merge
const lit = hit({
  search_document_id: "literal:x#L1",
  object_type: "PROGRAM",
  knowledge_unit_type: "code_unit",
  object_name: "Z_RVADIN01",
  snippet: "kschl = 'ZRAH'.",
  hardcoded_values: ["ZRAH"],
  metadata: { portable_literal: true, bound_fields: ["KSCHL"] },
  exact_score: 4,
});
const form = hit({
  search_document_id: "canonical-code:form",
  object_type: "CODE_UNIT",
  knowledge_unit_type: "code_unit",
  object_name: "Z_RVADIN01",
  snippet:
    "FORM zrah_leergut_item_print USING ps_vbdpr TYPE vbdpr. kschl = 'ZRAH'.",
  exact_score: 2,
});
assert.notEqual(
  canonicalEvidenceIdentity(lit),
  canonicalEvidenceIdentity(form),
);
assert.ok(canonicalEvidenceIdentity(lit).startsWith("literal|"));
assert.ok(/FORM\|ZRAH_LEERGUT_ITEM_PRINT/.test(canonicalEvidenceIdentity(form)));
const zrahDedup = dedupeFinalEvidenceHits([lit, form, lit]);
assert.equal(zrahDedup.hits.length, 2);

// Different partner profiles must not merge
const o1 = hit({
  search_document_id: "o1",
  knowledge_unit_type: "message_idoc_object",
  object_type: "partner_profile",
  object_name: "LS|OCTOPUS",
});
const o2 = hit({
  search_document_id: "o2",
  knowledge_unit_type: "message_idoc_object",
  object_type: "partner_profile",
  object_name: "LS|OCTOPUS|ZCSVFILE",
});
assert.notEqual(canonicalEvidenceIdentity(o1), canonicalEvidenceIdentity(o2));
assert.equal(dedupeFinalEvidenceHits([o1, o2]).hits.length, 2);

const stmts = dedupeClaimStatements([
  { text: "ZRAH in Z_RVADIN01", source_ranks: [1], source_ids: ["a"] },
  { text: "ZRAH in Z_RVADIN01", source_ranks: [2], source_ids: ["b"] },
]);
assert.equal(stmts.length, 1);
assert.deepEqual(stmts[0]!.source_ranks, [1, 2]);

console.log("unresolvedQualifierAndDedup.test.ts: ok");
