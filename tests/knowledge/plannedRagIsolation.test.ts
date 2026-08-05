/**
 * Negative regression tests A–D for planned_rag context isolation + topic grounding.
 * Does not touch direct_rag ranking/retrieval.
 *
 *   npx tsx tests/knowledge/plannedRagIsolation.test.ts
 */
import assert from "assert";
import {
  askCacheIdentity,
  buildAskCacheKeyString,
  normalizeAskQuestion,
} from "../../src/lib/app/askSessionCache";
import type { KnowledgeHit } from "../../src/lib/knowledge/types";
import {
  PLANNED_RAG_PLANNER_VERSION,
  createPlannedRagRunState,
  createPlannedRunId,
  groundPlannedCandidates,
  synthesisHitsFromTopicGrounding,
} from "../../src/lib/knowledge/plannedTopicGrounding";

function hit(partial: Partial<KnowledgeHit> & { id: string; key: string }): KnowledgeHit {
  return {
    rank: partial.rank ?? 1,
    search_document_id: partial.id,
    source_key: partial.key,
    title: partial.title ?? partial.key,
    knowledge_unit_type: "code_unit",
    combined_score: partial.combined_score ?? 1,
    exact_score: partial.exact_score ?? 0,
    fulltext_score: partial.fulltext_score ?? 0,
    vector_score: partial.vector_score ?? 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.8,
    matched_terms: [],
    snippet: partial.snippet ?? "",
    evidence_refs: [],
    facts: partial.facts ?? [],
    inferences: [],
    metadata: {},
    object_name: partial.object_name ?? "ZCL_EXT",
    object_type: "CLASS",
    subobject_name: partial.subobject_name ?? "",
    technical_summary: partial.technical_summary ?? "",
    business_purpose: partial.business_purpose ?? "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: [],
    entities: partial.entities ?? [],
    relations: [],
    evidence: partial.evidence ?? [],
    doc_confidence: 0.8,
  };
}

const konzernfarbe = hit({
  id: "konzern",
  key: "D01|CLASS|ZCL_EXT|METHOD|SET_KONZERNFARBE",
  subobject_name: "SET_KONZERNFARBE",
  title: "CLASS / ZCL_EXT / METHOD / SET_KONZERNFARBE",
  exact_score: 0,
  combined_score: 0.4,
  snippet:
    "SET_KONZERNFARBE setzt Konzernfarbe für Coca-Cola und Edeka-Kundennummern in KNVP.",
  technical_summary:
    "Ermittelt Konzernfarbe anhand Kunden- und Partnerdaten für Konzerne wie Coca-Cola.",
  facts: ["SET_KONZERNFARBE setzt R_KONZERNFARBE für bestimmte Kunden"],
  business_purpose: "Konzernfarbe / Segmentierung von Auslieferungen",
});

const zvlager = hit({
  id: "zvlager",
  key: "D01|TABLE|ZVLAGER_AUART",
  title: "ZVLAGER_AUART — virtuelles Lager Auftragsarten",
  object_name: "ZVLAGER_AUART",
  exact_score: 8,
  combined_score: 14,
  snippet:
    "Steuert erlaubte Auftragsarten für das virtuelle Lager bei Edeka.",
  technical_summary:
    "Customizing-Tabelle ZVLAGER_AUART definiert Auftragsarten im virtuellen Lager.",
  facts: ["ZVLAGER_AUART sperrt bestimmte AUART für virtuelles Lager"],
  business_purpose: "Virtuelles Lager Edeka — Auftragsartensteuerung",
});

const zztvag = hit({
  id: "zztvag",
  key: "D01|FIELD|ZZTVAG",
  title: "ZZTVAG virtuelles Lager Kennzeichen",
  object_name: "ZZTVAG",
  exact_score: 6,
  combined_score: 12,
  snippet: "Feld ZZTVAG markiert Belege für virtuelles Lager (Edeka).",
  technical_summary: "ZZTVAG = Kennzeichen virtuelles Lager",
  facts: ["ZZTVAG steuert virtuelles Lager"],
  business_purpose: "Virtuelles Lager Prozesskennzeichen",
});

function assertNoKonzernInSynthesis(question: string, candidates: KnowledgeHit[]) {
  const runId = createPlannedRunId();
  const grounded = groundPlannedCandidates({
    run_id: runId,
    question,
    candidates,
  });
  const syn = synthesisHitsFromTopicGrounding(grounded.kept);
  const keys = syn.synthesis_hits.map((h) => h.source_key);
  assert.ok(
    !keys.some((k) => /SET_KONZERNFARBE/i.test(k)),
    `SET_KONZERNFARBE must be excluded for: ${question}; got ${keys.join(", ")}`,
  );
  const excluded = grounded.excluded.find((e) =>
    /SET_KONZERNFARBE/i.test(e.source_key),
  );
  assert.ok(excluded, "SET_KONZERNFARBE must appear in excluded with reason");
  assert.equal(excluded!.status, "not_relevant");
  return { grounded, syn, runId };
}

/** Test A: prior Coca-Cola/Konzernfarbe context must not leak into Edeka virtual warehouse. */
function testA_noCocaColaLeak() {
  // Simulate fused candidates after a prior Coca-Cola question would have surfaced konzernfarbe,
  // then a NEW isolated question about virtual warehouse.
  const q2 = "Wie funktioniert das virtuelle Lager bei Edeka?";
  const { syn } = assertNoKonzernInSynthesis(q2, [
    konzernfarbe,
    zvlager,
    zztvag,
  ]);
  assert.ok(
    syn.synthesis_hits.some((h) => /ZVLAGER_AUART/i.test(h.source_key)),
    "ZVLAGER_AUART must remain",
  );
  assert.ok(
    syn.fact_hits.every((h) => h.topic_status === "confirmed"),
    "facts only confirmed",
  );
  console.log("ok Test A — no Coca-Cola/Konzernfarbe leak into Edeka virtual warehouse");
}

/** Test B: prior Edeka/Konzernfarbe must not pollute virtual-warehouse order-type question. */
function testB_edekaKonzernThenVirtualWarehouse() {
  const q2 =
    "Welche Auftragsarten sind im virtuellen Lager nicht erlaubt?";
  const { syn, grounded } = assertNoKonzernInSynthesis(q2, [
    konzernfarbe,
    zvlager,
    zztvag,
  ]);
  assert.ok(
    syn.synthesis_hits.every((h) =>
      /virtuell|ZVLAGER|ZZTVAG|Lager/i.test(
        `${h.source_key} ${h.snippet} ${h.technical_summary}`,
      ),
    ),
    "only virtual-warehouse-related evidence",
  );
  assert.ok(
    grounded.kept.some(
      (h) =>
        /ZVLAGER_AUART/i.test(h.source_key) && h.topic_status === "confirmed",
    ),
    "ZVLAGER_AUART confirmed",
  );
  console.log("ok Test B — only virtual-warehouse evidence after Edeka/Konzernfarbe");
}

/** Test C: planned filter may enrich but must not add off-topic sources. */
function testC_plannedMustNotAddForeignSources() {
  const q =
    "Was wurde genau gemacht, um die Anforderungen von Edeka im Bereich virtuelles Lager so zu erfüllen?";
  // direct_rag-like set (correct)
  const directLike = [zvlager, zztvag];
  // planned_rag fused set wrongly adds konzernfarbe (exact=0)
  const plannedFused = [zvlager, zztvag, konzernfarbe];

  const directGround = groundPlannedCandidates({
    run_id: createPlannedRunId(),
    question: q,
    candidates: directLike,
  });
  const plannedGround = groundPlannedCandidates({
    run_id: createPlannedRunId(),
    question: q,
    candidates: plannedFused,
  });

  const directKeys = new Set(
    synthesisHitsFromTopicGrounding(directGround.kept).synthesis_hits.map(
      (h) => h.source_key,
    ),
  );
  const plannedKeys = synthesisHitsFromTopicGrounding(
    plannedGround.kept,
  ).synthesis_hits.map((h) => h.source_key);

  for (const k of plannedKeys) {
    // planned may only keep keys that are on-topic; foreign konzern must be gone
    assert.ok(!/SET_KONZERNFARBE/i.test(k), `foreign source leaked: ${k}`);
  }
  // All direct keys should still be admissible under planned grounding
  for (const k of directKeys) {
    assert.ok(
      plannedKeys.includes(k),
      `planned dropped on-topic direct hit ${k}`,
    );
  }
  console.log("ok Test C — planned_rag does not add foreign sources vs direct set");
}

/** Test D: new question in same session ⇒ fresh run_id and isolated arrays. */
function testD_newQuestionFreshRunId() {
  const run1 = createPlannedRagRunState("Frage nach Coca Cola Konzernfarbe");
  run1.subqueries = [{ id: "sq1", query: "Coca Cola Konzernfarbe" }];
  run1.candidates_before = [konzernfarbe];
  run1.evidence_ids = [konzernfarbe.search_document_id];

  const run2 = createPlannedRagRunState(
    "Wie funktioniert das virtuelle Lager bei Edeka?",
  );
  assert.notEqual(run1.run_id, run2.run_id, "run_id must be unique per question");
  assert.equal(run2.subqueries.length, 0, "fresh run starts with empty subqueries");
  assert.equal(run2.candidates_before.length, 0, "fresh run clears candidates");
  assert.equal(run2.evidence_ids.length, 0, "fresh run clears evidence");

  // Mutating run1 must not affect run2
  run1.evidence_ids.push("leak");
  assert.ok(!run2.evidence_ids.includes("leak"));

  const idA = createPlannedRunId();
  const idB = createPlannedRunId();
  assert.notEqual(idA, idB);

  // Display cache: different questions never share identity
  const cacheA = askCacheIdentity(
    "proj",
    normalizeAskQuestion("Coca Cola?"),
    "planned_rag",
  );
  const cacheB = askCacheIdentity(
    "proj",
    normalizeAskQuestion("Wie funktioniert das virtuelle Lager bei Edeka?"),
    "planned_rag",
  );
  assert.notEqual(cacheA, cacheB);

  const keyA = buildAskCacheKeyString({
    projectId: "proj",
    sessionId: "same-session",
    normalizedQuestion: "Coca Cola?",
    searchMode: "planned_rag",
    activeIndexHash: "idx1",
    plannerVersion: PLANNED_RAG_PLANNER_VERSION,
    indexVersion: "indexes/search",
    searchProfileVersion: "sp1",
    answerPromptVersion: "ap1",
  });
  const keyB = buildAskCacheKeyString({
    projectId: "proj",
    sessionId: "same-session",
    normalizedQuestion: "Wie funktioniert das virtuelle Lager bei Edeka?",
    searchMode: "planned_rag",
    activeIndexHash: "idx1",
    plannerVersion: PLANNED_RAG_PLANNER_VERSION,
    indexVersion: "indexes/search",
    searchProfileVersion: "sp1",
    answerPromptVersion: "ap1",
  });
  assert.notEqual(keyA, keyB, "cache key isolates questions in same session");

  console.log("ok Test D — fresh run_id and isolated state per question");
}

function testTopicStatusesForCase() {
  const q =
    "Was wurde genau gemacht, um die Anforderungen von Edeka im Bereich virtuelles Lager so zu erfüllen?";
  const grounded = groundPlannedCandidates({
    run_id: createPlannedRunId(),
    question: q,
    candidates: [zvlager, zztvag, konzernfarbe],
  });
  const byKey = new Map(
    [...grounded.kept, ...grounded.excluded.map((e) => {
      const h = [zvlager, zztvag, konzernfarbe].find(
        (x) => x.search_document_id === e.search_document_id,
      )!;
      return {
        ...h,
        topic_status: e.status,
        topic_reason: e.reason,
        topic_matched: [] as string[],
      };
    })].map((h) => [h.source_key, h.topic_status]),
  );
  // excluded entries aren't in kept — check explicitly
  assert.ok(
    grounded.kept.some(
      (h) =>
        /ZVLAGER_AUART/i.test(h.source_key) && h.topic_status === "confirmed",
    ),
  );
  assert.ok(
    grounded.kept.some(
      (h) => /ZZTVAG/i.test(h.source_key) && h.topic_status === "confirmed",
    ),
  );
  assert.ok(
    grounded.excluded.some(
      (e) =>
        /SET_KONZERNFARBE/i.test(e.source_key) && e.status === "not_relevant",
    ),
    `expected SET_KONZERNFARBE not_relevant; excluded=${JSON.stringify(grounded.excluded)} kept=${JSON.stringify(grounded.kept.map((k) => [k.source_key, k.topic_status]))}`,
  );
  void byKey;
  console.log("ok topic statuses — ZVLAGER/ZZTVAG confirmed, SET_KONZERNFARBE not_relevant");
}

function main() {
  testA_noCocaColaLeak();
  testB_edekaKonzernThenVirtualWarehouse();
  testC_plannedMustNotAddForeignSources();
  testD_newQuestionFreshRunId();
  testTopicStatusesForCase();
  console.log("\nAll planned_rag isolation regression tests (A–D) passed.");
}

main();
