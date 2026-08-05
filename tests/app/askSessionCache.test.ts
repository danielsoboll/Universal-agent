/**
 *   npx tsx tests/app/askSessionCache.test.ts
 */
import assert from "assert";
import {
  askCacheIdentity,
  buildAskCacheKeyString,
  normalizeAskQuestion,
} from "../../src/lib/app/askSessionCache";
import { PLANNED_RAG_PLANNER_VERSION } from "../../src/lib/knowledge/plannedTopicGrounding";

function testNormalize() {
  assert.equal(
    normalizeAskQuestion("  Hallo   Welt  "),
    "Hallo Welt",
  );
  console.log("ok normalize");
}

function testKeysSeparateQuestionsAndModes() {
  const a = askCacheIdentity("proj1", "frage a", "direct_rag");
  const b = askCacheIdentity("proj1", "frage b", "direct_rag");
  const c = askCacheIdentity("proj1", "frage a", "planned_rag");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(
    askCacheIdentity("proj1", "frage a", "direct_rag"),
    a,
  );
  const fullA = buildAskCacheKeyString({
    projectId: "proj1",
    sessionId: "s1",
    normalizedQuestion: "frage a",
    searchMode: "direct_rag",
    activeIndexHash: "hash1",
    plannerVersion: "",
    indexVersion: "indexes/search",
    searchProfileVersion: "search.sap.v1",
    answerPromptVersion: "v1",
  });
  const fullB = buildAskCacheKeyString({
    projectId: "proj1",
    sessionId: "s1",
    normalizedQuestion: "frage b",
    searchMode: "direct_rag",
    activeIndexHash: "hash1",
    plannerVersion: "",
    indexVersion: "indexes/search",
    searchProfileVersion: "search.sap.v1",
    answerPromptVersion: "v1",
  });
  assert.notEqual(fullA, fullB);

  const planned = buildAskCacheKeyString({
    projectId: "proj1",
    sessionId: "s1",
    normalizedQuestion: "frage a",
    searchMode: "planned_rag",
    activeIndexHash: "hash1",
    plannerVersion: PLANNED_RAG_PLANNER_VERSION,
    indexVersion: "indexes/search",
    searchProfileVersion: "search.sap.v1",
    answerPromptVersion: "v1",
  });
  const plannedOtherIndex = buildAskCacheKeyString({
    projectId: "proj1",
    sessionId: "s1",
    normalizedQuestion: "frage a",
    searchMode: "planned_rag",
    activeIndexHash: "hash2",
    plannerVersion: PLANNED_RAG_PLANNER_VERSION,
    indexVersion: "indexes/search",
    searchProfileVersion: "search.sap.v1",
    answerPromptVersion: "v1",
  });
  assert.notEqual(planned, plannedOtherIndex, "active_index_hash isolates cache");

  const full = buildAskCacheKeyString({
    projectId: "proj1",
    sessionId: "s1",
    normalizedQuestion: "frage a",
    searchMode: "full_analysis",
    activeIndexHash: "hash1",
    plannerVersion: "full-analysis-v1",
    indexVersion: "indexes/search",
    searchProfileVersion: "search.sap.v1",
    answerPromptVersion: "v1",
  });
  assert.notEqual(full, planned, "full_analysis cache key differs from planned_rag");
  console.log("ok cache keys isolate question, mode, and index hash");
}

testNormalize();
testKeysSeparateQuestionsAndModes();
console.log("\naskSessionCache tests passed.");
