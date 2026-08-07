/**
 * Schema / mapping unit checks for anchor RAG.
 *   npx tsx tests/knowledge/anchorRagSchema.test.ts
 */
import assert from "assert";
import {
  mapLegacyRelation,
  mapMessageIdocObjectType,
  mapCodeUnitObjectType,
  mapEntityReferenceRelation,
} from "../../src/lib/knowledge/anchorRag/relationCatalog";
import {
  buildEvidenceGraph,
  buildEvidencePackage,
} from "../../src/lib/knowledge/anchorRag/evidenceGraph";
import type {
  EvidenceGraphNode,
  EvidenceGraphEdge,
} from "../../src/lib/knowledge/anchorRag/types";

assert.equal(mapLegacyRelation("CALLS_FUNCTION"), "CODE_CALLS_FUNCTION_MODULE");
assert.equal(mapLegacyRelation("PERFORMS"), "CODE_PERFORMS_FORM_ROUTINE");
assert.equal(mapLegacyRelation("OUTPUT_TYPE_TO_PROGRAM"), "OUTPUT_TYPE_PROCESSED_BY_PROGRAM");
assert.equal(mapLegacyRelation("PARTNER_TO_PORT"), "PARTNER_PROFILE_USES_PORT");
assert.equal(mapMessageIdocObjectType("output_type"), "OUTPUT_TYPE");
assert.equal(mapCodeUnitObjectType("PROGRAM", "FORM"), "FORM_ROUTINE");
assert.equal(
  mapEntityReferenceRelation("customer_number"),
  "CONTROL_ROW_REFERENCES_CUSTOMER",
);

const nodes: EvidenceGraphNode[] = [
  {
    id: "node:OUTPUT_TYPE:B|V1|DEMO",
    type: "OUTPUT_TYPE",
    name: "DEMO",
    source: "test",
    source_path: "canonical/message-idoc-config/objects.jsonl",
    exact_match: true,
    score: 0.99,
    attributes: {},
  },
  {
    id: "node:PROGRAM:Z_PROCESS_DEMO",
    type: "PROGRAM",
    name: "Z_PROCESS_DEMO",
    source: "test",
    source_path: "canonical/programs/extracts.jsonl",
    exact_match: true,
    score: 0.95,
    attributes: {},
  },
];
const edges: EvidenceGraphEdge[] = [
  {
    from: "node:OUTPUT_TYPE:B|V1|DEMO",
    relation: "OUTPUT_TYPE_PROCESSED_BY_PROGRAM",
    to: "node:PROGRAM:Z_PROCESS_DEMO",
    resolution: "RESOLVED_STATIC",
    evidence: ["test"],
    confidence: 0.9,
  },
];
const graph = buildEvidenceGraph({
  question: "Was wissen wir über die Nachricht DEMO?",
  primaryAnchors: ["DEMO"],
  nodes,
  edges,
});
const pkg = buildEvidencePackage({
  question: graph.question,
  graph,
  inventories: [
    {
      anchor: "DEMO",
      hits_by_type: {
        PROGRAM: 1,
        INCLUDE: 0,
        FORM_ROUTINE: 0,
        FUNCTION_MODULE: 0,
        METHOD: 0,
        CLASS: 0,
        CONTROL_TABLE: 0,
        CONTROL_TABLE_ROW: 0,
        OUTPUT_TYPE: 1,
        OUTPUT_TYPE_TEXT: 0,
        OUTPUT_PROCESSING: 0,
        MESSAGE_TYPE: 0,
        IDOC_TYPE: 0,
        PARTNER_PROFILE: 0,
        MASTER_DATA_FIELD: 0,
        MASTER_DATA_VALUE: 0,
        PROCESS_CODE: 0,
        PORT: 0,
        OTHER: 0,
      },
      hits: [],
    },
  ],
});
assert.ok(pkg.proven_claims.some((c) => c.includes("OUTPUT_TYPE")));
assert.equal(pkg.call_chains.length, 1);
assert.ok(pkg.open_questions.some((q) => /IDoc/i.test(q)));

// Medium mapping (generic, not per-message)
import { resolveMedium } from "../../src/lib/knowledge/anchorRag/mediumMapping";
const m8 = resolveMedium("8");
assert.equal(m8.resolution, "GENERIC_SAP_MAPPING");
assert.equal(m8.medium_text, "Spezialfunktion");
const mUnk = resolveMedium("ZZ");
assert.equal(mUnk.resolution, "UNRESOLVED");
assert.equal(mUnk.medium_text, "unbekannt");

console.log("anchorRagSchema.test.ts OK");
