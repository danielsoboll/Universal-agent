/**
 *   npx tsx tests/knowledge/seedEnrichment.test.ts
 */
import assert from "assert";
import {
  classifyPresentationHint,
  hasDeterministicSeedEvidence,
  mergePreserveConfirmedSeedEvidence,
  parseFieldLikeSeeds,
} from "../../src/lib/knowledge/seedEnrichment";
import type { KnowledgeHit } from "../../src/lib/knowledge/types";

const how = classifyPresentationHint(
  "Wie funktioniert das Edeka virtuelle Lager?",
);
assert.strictEqual(how.hint, "how_works");

const where = classifyPresentationHint("Wo wird ZZ_VLAGER verwendet?");
assert.strictEqual(where.hint, "where_used");

const which = classifyPresentationHint("Welche Kunden haben ZZ_VLAGER gesetzt?");
assert.strictEqual(which.hint, "which_instances");

const seeds = parseFieldLikeSeeds([
  "ZZ_VLAGER",
  "KNVV-ZZ_VLAGER",
  "EDEKA",
  "ZCL_FOO",
]);
assert.ok(seeds.some((s) => s.field_name === "ZZ_VLAGER"));
assert.ok(seeds.some((s) => s.table_name === "KNVV"));
assert.ok(!seeds.some((s) => s.seed === "EDEKA"));
assert.ok(!seeds.some((s) => s.seed === "ZCL_FOO"));

function baseHit(id: string, extra: Partial<KnowledgeHit> = {}): KnowledgeHit {
  return {
    rank: 1,
    search_document_id: id,
    source_key: id,
    title: id,
    knowledge_unit_type: "code_unit",
    combined_score: 1,
    exact_score: 1,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.5,
    matched_terms: [],
    snippet: "",
    evidence_refs: [],
    facts: [],
    inferences: [],
    metadata: {},
    object_name: "",
    object_type: "",
    subobject_name: "",
    technical_summary: "",
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: [],
    entities: [],
    relations: [],
    evidence: [],
    doc_confidence: 0.5,
    ...extra,
  };
}

const seedHit = baseHit("enrichment:field:FOO", {
  metadata: { seed_enrichment: true },
  matched_terms: ["seed_enrichment"],
  facts: [
    "FOO ist bei 3 Vertriebsbereichszuordnungen gesetzt (2 Kunden).",
    "Code-Usage zu FOO: 4 belegte Links.",
    "Beispiel: 1000 Test — VKORG 0100/01/00 = X",
  ],
  evidence: [
    {
      statement_type: "fact",
      text: "FOO ist bei 3 Vertriebsbereichszuordnungen gesetzt (2 Kunden).",
      lines: [],
    },
  ],
});
assert.ok(hasDeterministicSeedEvidence(seedHit));

const emptyStub = baseHit("enrichment:field:EMPTY", {
  metadata: { seed_enrichment: true },
  matched_terms: ["seed_enrichment"],
  facts: ["DDIC EMPTY: Beschreibung ohne Treffer"],
  evidence: [],
});
assert.ok(!hasDeterministicSeedEvidence(emptyStub));

const merged = mergePreserveConfirmedSeedEvidence(
  [baseHit("only-theme")],
  [seedHit, baseHit("only-theme"), baseHit("other")],
);
assert.strictEqual(merged[0]!.search_document_id, "enrichment:field:FOO");
assert.ok(merged.some((h) => h.search_document_id === "only-theme"));
assert.ok(!merged.some((h) => h.search_document_id === "other"));

console.log("seedEnrichment.test.ts OK");
