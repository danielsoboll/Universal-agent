/**
 * Unit tests for planned_rag-only retrieval helpers (no OpenAI, no direct_rag changes).
 *   npx tsx tests/knowledge/plannedRagFusion.test.ts
 */
import assert from "assert";
import {
  fuseBaselineAndSubqueries,
  refinePlanSubqueries,
  resolvePlannedTypeFilter,
} from "../../src/lib/knowledge/executePlannedRag";
import type { KnowledgeHit } from "../../src/lib/knowledge/types";
import type { QueryPlan } from "../../src/lib/knowledge/queryPlanSchema";

function hit(
  id: string,
  rank: number,
  score: number,
  key = id,
): KnowledgeHit {
  return {
    rank,
    search_document_id: id,
    source_key: key,
    title: key,
    knowledge_unit_type: "code_unit",
    combined_score: score,
    exact_score: score,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.8,
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
    doc_confidence: 0.8,
  };
}

function testRefineDedupAndCap() {
  const plan = {
    schema_version: "query-plan-v1",
    original_question: "q",
    normalized_question: "q",
    intent: "unknown",
    answer_scope: "process_and_technical",
    entities: [],
    search_concepts: [],
    subqueries: [
      { id: "q1", query: "Alpha", purpose: "", target_types: [], metadata_filters: {}, relation_expansion: "none" },
      { id: "q2", query: "  alpha ", purpose: "", target_types: [], metadata_filters: {}, relation_expansion: "none" },
      { id: "q3", query: "Beta", purpose: "", target_types: [], metadata_filters: {}, relation_expansion: "none" },
      { id: "q4", query: "Gamma", purpose: "", target_types: [], metadata_filters: {}, relation_expansion: "none" },
      { id: "q5", query: "Delta", purpose: "", target_types: [], metadata_filters: {}, relation_expansion: "none" },
      { id: "q6", query: "Epsilon", purpose: "", target_types: [], metadata_filters: {}, relation_expansion: "none" },
    ],
    required_evidence: [],
    ambiguities: [],
    planner_confidence: 0.9,
  } as QueryPlan;
  const refined = refinePlanSubqueries(plan);
  assert.equal(refined.length, 4);
  assert.equal(refined[0]!.query, "Alpha");
  assert.ok(!refined.some((s) => s.id === "q2"));
  console.log("ok refinePlanSubqueries dedupe+cap");
}

function testSoftTypeFilter() {
  const mapping = {
    content_unit: ["document_chunk"],
    business_rule: ["business_rule"],
    code_unit: ["code_unit"],
  };
  assert.equal(
    resolvePlannedTypeFilter({
      targetTypes: ["content_unit"],
      mapping,
      plannerConfidence: 0.5,
      availableIndexTypes: ["code_unit", "business_rule"],
    }),
    undefined,
    "low confidence → no filter",
  );
  assert.equal(
    resolvePlannedTypeFilter({
      targetTypes: ["content_unit"],
      mapping,
      plannerConfidence: 0.9,
      availableIndexTypes: ["code_unit", "business_rule"],
    }),
    undefined,
    "mapped type absent from index → no filter",
  );
  assert.deepEqual(
    resolvePlannedTypeFilter({
      targetTypes: ["code_unit"],
      mapping,
      plannerConfidence: 0.9,
      availableIndexTypes: ["code_unit", "business_rule"],
    }),
    ["code_unit"],
  );
  console.log("ok resolvePlannedTypeFilter soft rules");
}

function testBaselineProtection() {
  const baseline = [
    hit("a", 1, 16),
    hit("b", 2, 13),
    hit("c", 3, 12),
  ];
  const weakMulti = [
    hit("w1", 1, 0.1),
    hit("w2", 2, 0.1),
    hit("a", 3, 0.05), // also weakly in subquery
  ];
  const fused = fuseBaselineAndSubqueries({
    baselineHits: baseline,
    perSubquery: [
      { subqueryId: "sq1", hits: weakMulti },
      { subqueryId: "sq2", hits: [hit("w1", 1, 0.1), hit("w2", 2, 0.08)] },
    ],
    finalLimit: 5,
  });
  assert.equal(fused[0]!.search_document_id, "a", "strong baseline must stay on top");
  assert.ok(
    fused.some((h) => h.search_document_id === "b"),
    "baseline #2 retained",
  );
  console.log(
    "ok baseline protection",
    fused.map((h) => `${h.rank}:${h.source_key}`).join(", "),
  );
}

function main() {
  testRefineDedupAndCap();
  testSoftTypeFilter();
  testBaselineProtection();
  console.log("\nAll planned_rag fusion tests passed.");
}

main();
