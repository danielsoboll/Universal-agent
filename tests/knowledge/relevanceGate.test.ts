/**
 * Unit tests for relevance / evidence gate (no OpenAI, no retrieval).
 *   npx tsx tests/knowledge/relevanceGate.test.ts
 */
import assert from "assert";
import {
  assessRelevanceGate,
  extractQueryConcepts,
} from "../../src/lib/knowledge/relevanceGate";
import type { KnowledgeHit } from "../../src/lib/knowledge/types";
import type { GroundingReport } from "../../src/lib/knowledge/entityGrounding";

function hit(
  id: string,
  opts: Partial<KnowledgeHit> & { title?: string; snippet?: string } = {},
): KnowledgeHit {
  return {
    rank: 1,
    search_document_id: id,
    source_key: opts.source_key ?? id,
    title: opts.title ?? id,
    knowledge_unit_type: "code_unit",
    combined_score: 10,
    exact_score: 10,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.8,
    matched_terms: [],
    snippet: opts.snippet ?? "",
    evidence_refs: opts.evidence_refs ?? [],
    facts: opts.facts ?? [],
    inferences: opts.inferences ?? [],
    metadata: {},
    object_name: opts.object_name ?? "",
    object_type: opts.object_type ?? "",
    subobject_name: opts.subobject_name ?? "",
    technical_summary: opts.technical_summary ?? "",
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: opts.hardcoded_values ?? [],
    entities: opts.entities ?? [],
    relations: [],
    evidence: opts.evidence ?? [],
    doc_confidence: 0.8,
  };
}

function testExtractOptitoolConcepts() {
  const c = extractQueryConcepts(
    "Wo wird zwischen Optitool alt und neu unterschieden?",
  );
  assert.ok(
    c.some((x) => /optitool/i.test(x)),
    `expected Optitool in ${JSON.stringify(c)}`,
  );
  assert.ok(c.includes("alt") || c.includes("neu"), `expected alt/neu in ${JSON.stringify(c)}`);
}

function testExtractTechnicalId() {
  const c = extractQueryConcepts("Was macht SET_KONZERNFARBE?");
  assert.ok(
    c.some((x) => /SET_KONZERNFARBE/i.test(x)),
    `expected SET_KONZERNFARBE in ${JSON.stringify(c)}`,
  );
}

function testExtractDesadvConcept() {
  const c = extractQueryConcepts(
    "Für welche Kunden gibt es spezifische Anpassungen im DESADV-IDoc?",
  );
  assert.ok(
    c.some((x) => /desadv/i.test(x)),
    `expected DESADV in ${JSON.stringify(c)}`,
  );
  // Generic stopwords must not dominate
  assert.ok(!c.some((x) => /^kunden$/i.test(x)));
  assert.ok(!c.some((x) => /^spezifische$/i.test(x)));
}

function testAnswerableWhenConceptsEvidenced() {
  const hits = [
    hit("h1", {
      title: "CLASS / ZCL_EXT / METHOD / OT_UPDATE_CUSTOMER",
      snippet:
        "Optitool alt nutzt ZOTCO_IMPORT; Optitool neu nutzt ZCO_IMPORT_NEW3 für die Unterscheidung.",
      facts: ["Optitool alt: ZOTCO_IMPORT", "Optitool neu: ZCO_IMPORT_NEW3"],
      evidence_refs: ["#1"],
    }),
  ];
  const r = assessRelevanceGate({
    question: "Wo wird zwischen Optitool alt und neu unterschieden?",
    hits,
  });
  assert.equal(r.answerability, "answerable");
  assert.ok(r.supporting_source_ids.includes("h1"));
  assert.ok(r.matched_concepts.some((c) => /optitool/i.test(c)));
}

function testInsufficientWhenCentralConceptMissing() {
  const hits = [
    hit("h1", {
      title: "OT_UPDATE_CUSTOMER webservice",
      snippet:
        "Die Methode OT_UPDATE_CUSTOMER synchronisiert Kundendaten über einen Webservice-Proxy.",
      facts: ["OT_UPDATE_CUSTOMER ruft UPDATE_CUSTOMER"],
      evidence_refs: ["#1"],
      object_name: "OT_UPDATE_CUSTOMER",
    }),
  ];
  const r = assessRelevanceGate({
    question:
      "Für welche Kunden gibt es spezifische Anpassungen im DESADV-IDoc?",
    hits,
  });
  assert.equal(r.answerability, "insufficient");
  assert.equal(r.supporting_source_ids.length, 0);
  assert.ok(
    r.missing_concepts.some((c) => /desadv/i.test(c)),
    `expected DESADV missing, got ${JSON.stringify(r.missing_concepts)}`,
  );
  assert.ok(
    !/OT_UPDATE_CUSTOMER|webservice/i.test(r.reason) ||
      r.answerability === "insufficient",
  );
}

function testInsufficientOnUngroundedNamedEntity() {
  const grounding: GroundingReport = {
    query_entities: [
      {
        query_entity: "Pepsi Cola",
        entity_type: "customer_name",
        normalized_query_entity: "pepsi cola",
      },
    ],
    results: [
      {
        query_entity: "Pepsi Cola",
        entity_type: "customer_name",
        grounding_status: "not_found",
        matched_source_entities: [],
        evidence_refs: ["#1"],
        reason: "nicht gefunden",
      },
    ],
    has_ungrounded_named_entity: true,
    grounded_entity_names: [],
    contradicted_entity_names: ["Pepsi Cola"],
  };
  const hits = [
    hit("h1", {
      title: "SET_KONZERNFARBE",
      snippet:
        "Methode setzt Konzernfarbe 08 für Coca-Cola Auslieferungen anhand von Partnernummern.",
      facts: ["Coca-Cola Konzernfarbe 08"],
      evidence_refs: ["#1"],
    }),
  ];
  const r = assessRelevanceGate({
    question: "Welche Besonderheiten gibt es für Pepsi Cola?",
    hits,
    grounding,
  });
  assert.equal(r.answerability, "insufficient");
  assert.ok(r.contradicting_source_ids.length >= 0);
}

function testPartialWhenOnlySubsetMatched() {
  const hits = [
    hit("h1", {
      title: "AlphaModul Konfiguration",
      snippet:
        "Das AlphaModul steuert die Basisverarbeitung. Eine zweite Komponente wird hier nicht beschrieben.",
      facts: ["AlphaModul aktiv in der Basisverarbeitung"],
      evidence_refs: ["#1"],
      technical_summary:
        "AlphaModul steuert die Basisverarbeitung ohne zweite Komponente.",
      object_name: "AlphaModul",
    }),
  ];
  const r = assessRelevanceGate({
    question: "Wie interagieren AlphaModul und BetaModul miteinander?",
    hits,
  });
  assert.equal(
    r.answerability,
    "partially_answerable",
    `expected partial, got ${r.answerability}; concepts=${JSON.stringify(r)}`,
  );
  assert.ok(r.supporting_source_ids.includes("h1"));
  assert.ok(
    r.missing_concepts.some((c) => /beta/i.test(c)),
    `expected Beta missing: ${JSON.stringify(r.missing_concepts)}`,
  );
}

function testSetKonzernfarbeAnswerable() {
  const hits = [
    hit("h1", {
      title: "CLASS / ZCL_EXT / METHOD / SET_KONZERNFARBE",
      object_name: "SET_KONZERNFARBE",
      snippet:
        "SET_KONZERNFARBE ermittelt eine Konzernfarbe anhand von Kunden- und Lieferdaten.",
      facts: ["SET_KONZERNFARBE setzt R_KONZERNFARBE"],
      evidence_refs: ["#1"],
      technical_summary:
        "Die Methode SET_KONZERNFARBE ermittelt basierend auf Kundeninformationen eine Konzernfarbe.",
    }),
  ];
  const r = assessRelevanceGate({
    question: "Was macht SET_KONZERNFARBE?",
    hits,
  });
  assert.equal(r.answerability, "answerable");
  assert.ok(r.supporting_source_ids.includes("h1"));
}

const tests = [
  testExtractOptitoolConcepts,
  testExtractTechnicalId,
  testExtractDesadvConcept,
  testAnswerableWhenConceptsEvidenced,
  testInsufficientWhenCentralConceptMissing,
  testInsufficientOnUngroundedNamedEntity,
  testPartialWhenOnlySubsetMatched,
  testSetKonzernfarbeAnswerable,
];

let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`ok  ${t.name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${t.name}:`, e instanceof Error ? e.message : e);
  }
}
if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log(`All ${tests.length} relevanceGate tests passed.`);
