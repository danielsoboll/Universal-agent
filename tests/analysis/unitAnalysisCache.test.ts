/**
 * Unit tests for hardened analysis cache key evaluation.
 */
import assert from "node:assert/strict";
import {
  evaluateUnitAnalysisCache,
  withCacheMetadata,
} from "../../src/lib/analysis/unitAnalysisCache";
import {
  UNIT_ANALYSIS_PROMPT_VERSION,
  UNIT_ANALYSIS_SCHEMA_VERSION,
  type UnitAnalysisRecord,
} from "../../src/lib/analysis/unitAnalysisSchema";
import { AI_CONFIG } from "../../src/lib/ai/config";

function baseRecord(
  overrides: Partial<UnitAnalysisRecord> = {},
): UnitAnalysisRecord {
  return {
    technical_summary: "t",
    business_purpose_inferred: "b",
    facts: [],
    inferences: [],
    open_questions: [],
    tables_read: [],
    tables_written: [],
    called_functions: [],
    called_methods: [],
    hardcoded_values: [],
    special_cases: [],
    external_interfaces: [],
    risks: [],
    evidence_lines: [],
    confidence: 0.9,
    source_key: "D01|CLASS|X|METHOD|Y",
    class_name: "X",
    method_name: "Y",
    model: AI_CONFIG.chatModel,
    prompt_version: UNIT_ANALYSIS_PROMPT_VERSION,
    content_hash: "abc123",
    deterministic: {
      tables_read: [],
      tables_written: [],
      called_functions: [],
      called_methods: [],
      called_method_refs: [],
      macro_calls: [],
    },
    extraction_deviations: [],
    external_interfaces_classified: [],
    discarded_interfaces: [],
    macro_calls: [],
    relations: [],
    search_text: "",
    field_provenance: [],
    ...overrides,
  };
}

function main() {
  const hit = evaluateUnitAnalysisCache({
    existing: baseRecord(),
    source_key: "D01|CLASS|X|METHOD|Y",
    contentHash: "abc123",
  });
  assert.equal(hit.hit, true);
  assert.equal(hit.reason, "cache_hit");

  const missHash = evaluateUnitAnalysisCache({
    existing: baseRecord(),
    source_key: "D01|CLASS|X|METHOD|Y",
    contentHash: "other",
  });
  assert.equal(missHash.hit, false);
  assert.equal(missHash.reason, "content_hash_mismatch");

  const missModel = evaluateUnitAnalysisCache({
    existing: baseRecord({ model: "gpt-other" }),
    source_key: "D01|CLASS|X|METHOD|Y",
    contentHash: "abc123",
  });
  assert.equal(missModel.hit, false);
  assert.equal(missModel.reason, "model_mismatch");

  const missPrompt = evaluateUnitAnalysisCache({
    existing: baseRecord({ prompt_version: "old" }),
    source_key: "D01|CLASS|X|METHOD|Y",
    contentHash: "abc123",
  });
  assert.equal(missPrompt.hit, false);
  assert.equal(missPrompt.reason, "prompt_version_mismatch");

  // Legacy row without analysis_schema_version still hits (grandfather).
  const legacy = evaluateUnitAnalysisCache({
    existing: baseRecord({ analysis_schema_version: undefined }),
    source_key: "D01|CLASS|X|METHOD|Y",
    contentHash: "abc123",
  });
  assert.equal(legacy.hit, true);

  const schemaMismatch = evaluateUnitAnalysisCache({
    existing: baseRecord({ analysis_schema_version: "old-schema" }),
    source_key: "D01|CLASS|X|METHOD|Y",
    contentHash: "abc123",
  });
  assert.equal(schemaMismatch.hit, false);
  assert.equal(schemaMismatch.reason, "analysis_schema_version_mismatch");

  const missing = evaluateUnitAnalysisCache({
    existing: undefined,
    source_key: "D01|CLASS|X|METHOD|Y",
    contentHash: "abc123",
  });
  assert.equal(missing.hit, false);
  assert.equal(missing.reason, "missing");

  const needs = evaluateUnitAnalysisCache({
    existing: baseRecord({ needs_reanalysis: true }),
    source_key: "D01|CLASS|X|METHOD|Y",
    contentHash: "abc123",
  });
  assert.equal(needs.hit, false);
  assert.equal(needs.reason, "needs_reanalysis");

  const augmented = withCacheMetadata(baseRecord());
  assert.equal(augmented.source_hash, "abc123");
  assert.equal(augmented.analysis_schema_version, UNIT_ANALYSIS_SCHEMA_VERSION);
  assert.equal(augmented.model_version, AI_CONFIG.chatModel);

  console.log("unitAnalysisCache.test.ts: OK");
}

main();
