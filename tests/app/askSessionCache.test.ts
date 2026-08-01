/**
 *   npx tsx tests/app/askSessionCache.test.ts
 */
import assert from "assert";
import {
  askCacheIdentity,
  buildAskCacheKeyString,
  normalizeAskQuestion,
} from "../../src/lib/app/askSessionCache";

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
    indexVersion: "indexes/search",
    searchProfileVersion: "search.sap.v1",
    plannerPromptVersion: "",
    answerPromptVersion: "v1",
  });
  const fullB = buildAskCacheKeyString({
    projectId: "proj1",
    sessionId: "s1",
    normalizedQuestion: "frage b",
    searchMode: "direct_rag",
    indexVersion: "indexes/search",
    searchProfileVersion: "search.sap.v1",
    plannerPromptVersion: "",
    answerPromptVersion: "v1",
  });
  assert.notEqual(fullA, fullB);
  console.log("ok cache keys isolate question and mode");
}

testNormalize();
testKeysSeparateQuestionsAndModes();
console.log("\naskSessionCache tests passed.");
