/**
 * Unit tests for incremental class → hybrid merge / completeness (no I/O, no OpenAI).
 *
 *   npx tsx tests/search/syncClassAnalysesToHybrid.test.ts
 */
import assert from "assert";
import {
  isCompleteUnitAnalysis,
  mergeClassBatchIntoHybridDocs,
} from "../../src/lib/search/syncClassAnalysesToHybrid";
import type { SearchDocument } from "../../src/lib/search/searchDocumentSchema";

function doc(partial: Partial<SearchDocument> & { id: string; key: string; kut: string; src: string }): SearchDocument {
  return {
    search_document_id: partial.id,
    source_system: "D01",
    source_type: partial.src,
    source_key: partial.key,
    knowledge_unit_type: partial.kut,
    object_type: partial.object_type ?? "TABLE",
    object_name: partial.object_name ?? "X",
    subobject_name: partial.subobject_name ?? "",
    title: partial.title ?? partial.key,
    technical_summary: "",
    business_purpose: "",
    facts: [],
    inferences: [],
    entities: [],
    relations: [],
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    macro_calls: [],
    hardcoded_values: [],
    external_interfaces: [],
    risks: [],
    evidence: [],
    confidence: 0.9,
    analysis_version: "",
    content_hash: partial.content_hash ?? "h1",
    search_text: "x",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}

assert.ok(
  isCompleteUnitAnalysis({
    source_key: "D01|CLASS|ZCL_X|METHOD|M1",
    class_name: "ZCL_X",
    method_name: "M1",
    technical_summary: "A".repeat(25),
    facts: [{ text: "fact", evidence_lines: [] }],
    confidence: 0.9,
    content_hash: "abc",
  }),
);
assert.ok(
  !isCompleteUnitAnalysis({
    source_key: "D01|CLASS|ZCL_X|METHOD|M1",
    class_name: "ZCL_X",
    method_name: "M1",
    technical_summary: "kurz",
    facts: [],
    confidence: 0.9,
    content_hash: "abc",
  }),
);

const ct = doc({
  id: "ct1",
  key: "row1",
  kut: "table_row",
  src: "canonical_table_row",
});
const clsOld = doc({
  id: "c1",
  key: "D01|CLASS|ZCL_A|METHOD|OLD",
  kut: "code_unit",
  src: "code_unit_analysis",
  object_type: "CLASS",
  object_name: "ZCL_A",
  subobject_name: "OLD",
});
const clsKeep = doc({
  id: "c2",
  key: "D01|CLASS|ZCL_B|METHOD|KEEP",
  kut: "code_unit",
  src: "code_unit_analysis",
  object_type: "CLASS",
  object_name: "ZCL_B",
  subobject_name: "KEEP",
});
const clsNew = doc({
  id: "c3",
  key: "D01|CLASS|ZCL_COPYROUTINE_ZLNP|METHOD|REBUILD_CVBAP",
  kut: "code_unit",
  src: "code_unit_analysis",
  object_type: "CLASS",
  object_name: "ZCL_COPYROUTINE_ZLNP",
  subobject_name: "REBUILD_CVBAP",
});

const merged = mergeClassBatchIntoHybridDocs({
  existingDocs: [ct, clsOld, clsKeep],
  batchDocs: [clsNew],
});
assert.strictEqual(merged.nonClassCount, 1, "Control-Table muss erhalten bleiben");
assert.strictEqual(merged.classCount, 3, "alte Klassen + neuer Batch");
assert.ok(merged.merged.some((d) => d.search_document_id === "ct1"));
assert.ok(merged.merged.some((d) => d.subobject_name === "REBUILD_CVBAP"));
assert.ok(merged.merged.some((d) => d.subobject_name === "KEEP"));

console.log("syncClassAnalysesToHybrid.test.ts — OK");
