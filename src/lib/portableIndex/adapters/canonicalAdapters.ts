/**
 * Source → KnowledgeRecord adapters (thin boundary).
 * Today's canonical/search layouts are INPUT only — not the forever model.
 */
import type { KnowledgeSourceAdapter } from "@/lib/portableIndex/knowledgeRecord";
import type { KnowledgeRecord } from "@/lib/portableIndex/knowledgeRecord";
import type { PortableLiteralRecord } from "@/lib/portableIndex/literalTypes";
import type { PortableEvidenceDocument } from "@/lib/portableIndex/types";
import type { PortableSymbolRecord } from "@/lib/portableIndex/types";

export const searchDocumentsAdapter: KnowledgeSourceAdapter = {
  id: "sap_search_documents",
  source_family: "search_documents",
  description:
    "Bestehende indexes/search/search_documents.jsonl → Evidence + Symbol seeds",
  listSourcePaths: ({ projectId }) => [
    `indexes/search/search_documents.jsonl`,
    // projectId unused in path template — kept for future multi-root
    ...(projectId ? [] : []),
  ],
};

export const abapCodeUnitsAdapter: KnowledgeSourceAdapter = {
  id: "sap_abap_code_units",
  source_family: "abap_code",
  description:
    "canonical/{classes,programs,function-modules}/code_units.jsonl → CODE_UNIT / LITERAL / CODE_REFERENCE",
  listSourcePaths: () => [
    "canonical/classes/code_units.jsonl",
    "canonical/programs/code_units.jsonl",
    "canonical/function-modules/code_units.jsonl",
  ],
};

export const knowledgeGraphAdapter: KnowledgeSourceAdapter = {
  id: "sap_knowledge_graph",
  source_family: "knowledge_graph",
  description:
    "canonical/knowledge-graph/{nodes,edges}.jsonl → OBJECT / RELATION (graph access index only)",
  listSourcePaths: () => [
    "canonical/knowledge-graph/nodes.jsonl",
    "canonical/knowledge-graph/edges.jsonl",
  ],
};

export const lexicalCanonicalAdapter: KnowledgeSourceAdapter = {
  id: "sap_lexical_canonical",
  source_family: "master_data",
  description:
    "Canonical master-data / control-tables / message-idoc texts → TEXT / MASTER_DATA for lexical index",
  listSourcePaths: () => [
    "canonical/master-data/",
    "canonical/control-tables/",
    "canonical/message-idoc-config/objects.jsonl",
  ],
};

export const ACCESS_INDEX_ADAPTERS: KnowledgeSourceAdapter[] = [
  searchDocumentsAdapter,
  abapCodeUnitsAdapter,
  knowledgeGraphAdapter,
  lexicalCanonicalAdapter,
];

/** Map portable evidence row → neutral KnowledgeRecord (Evidence). */
export function knowledgeRecordFromEvidence(
  e: PortableEvidenceDocument,
): KnowledgeRecord {
  return {
    id: `evidence:${e.document_id}`,
    project_id: e.project_id,
    system_id: e.system_id,
    entity_type: e.knowledge_unit_type,
    entity_id: e.document_id,
    entity_name: e.object_name || e.title,
    record_type: "EVIDENCE",
    source_type: e.source_type || e.knowledge_unit_type || "search_document",
    source_key: e.source_key,
    relative_source_path: e.source_path || "indexes/evidence-store/documents.jsonl",
    content_hash: e.content_hash,
    object_type: e.object_type,
    object_name: e.object_name,
    subobject_name: e.subobject_name,
    text: e.technical_summary || e.search_text.slice(0, 2000),
    metadata: {
      facts_count: e.facts.length,
      evidence_count: e.evidence.length,
      portable_evidence: true,
    },
  };
}

/** Map symbol row → OBJECT KnowledgeRecord. */
export function knowledgeRecordFromSymbol(
  s: PortableSymbolRecord,
): KnowledgeRecord {
  return {
    id: `symbol:${s.document_id}`,
    project_id: s.project_id,
    system_id: s.system_id,
    entity_type: s.knowledge_unit_type || s.object_type,
    entity_id: s.document_id,
    entity_name: s.object_name,
    record_type: "OBJECT",
    source_type: "search_document",
    source_key: s.source_key,
    relative_source_path: "indexes/symbol-index/symbols.jsonl",
    content_hash: s.content_hash || "unknown",
    object_type: s.object_type,
    object_name: s.object_name,
    subobject_name: s.subobject_name,
    text: s.title,
  };
}

/** Map literal index row → LITERAL KnowledgeRecord (findability only). */
export function knowledgeRecordFromLiteral(
  lit: PortableLiteralRecord,
): KnowledgeRecord {
  return {
    id: `literal:${lit.literal_id}`,
    project_id: lit.project_id,
    system_id: lit.system_id,
    entity_type: "literal",
    entity_id: lit.literal_id,
    entity_name: lit.normalized_value,
    record_type: "LITERAL",
    source_type: "abap_code",
    source_key: lit.source_key,
    relative_source_path: lit.source_path,
    content_hash: lit.content_hash,
    object_type: lit.object_type,
    object_name: lit.object_name,
    subobject_name: lit.method_or_routine,
    field_name: lit.bound_fields[0],
    literal_value: lit.literal_value,
    normalized_literal: lit.normalized_value,
    technical_context: [
      ...lit.bound_fields,
      ...lit.candidate_roles,
      ...lit.context_tokens.slice(0, 12),
    ],
    statement_preview: lit.statement_preview,
    line_start: lit.line_start,
    line_end: lit.line_end,
    parent_id: lit.code_unit_id,
    metadata: {
      literal_type: lit.literal_type,
      bound_fields: lit.bound_fields,
      candidate_roles: lit.candidate_roles,
      in_comment: lit.in_comment,
      /** Proof is NOT this record — resolve via source_key + line. */
      evidence_via: "source_key+line",
    },
  };
}
