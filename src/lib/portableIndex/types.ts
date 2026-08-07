/**
 * Portable local index layer — schemas (project/system portable, no absolute paths).
 * Designed for later Supabase/Postgres mapping without redesign.
 */

export const PORTABLE_INDEX_VERSION = "portable-index-v1";

export type PortableSourceStamp = {
  /** Relative to project root (e.g. canonical/programs/code_units.jsonl) */
  relative_path: string;
  mtime_ms: number;
  size: number;
  content_hash: string;
};

export type PortableIndexManifest = {
  schema_version: typeof PORTABLE_INDEX_VERSION;
  project_id: string;
  system_id: string;
  built_at: string;
  builder: string;
  /** Combined fingerprint of all recorded sources. */
  sources_fingerprint: string;
  sources: PortableSourceStamp[];
  counts: {
    symbols: number;
    lexical_documents: number;
    lexical_token_postings: number;
    graph_nodes: number;
    graph_edges: number;
    evidence_documents: number;
    vector_refs: number;
    code_usage_postings: number;
    literals: number;
    literal_value_postings: number;
  };
  paths: {
    symbol_index: string;
    lexical_index: string;
    graph_index: string;
    evidence_store: string;
    vector_index: string;
    literal_index: string;
  };
  notes: string[];
};

/** symbol-index/symbols.jsonl */
export type PortableSymbolRecord = {
  document_id: string;
  source_key: string;
  project_id: string;
  system_id: string;
  object_type: string;
  object_name: string;
  subobject_name?: string;
  knowledge_unit_type?: string;
  title?: string;
  content_hash?: string;
};

/** symbol-index/by_name.jsonl — one line per uppercase name */
export type PortableSymbolNamePosting = {
  name: string;
  document_ids: string[];
};

/** lexical-index/documents.jsonl — compact LexicalDocument (source_path relative) */
export type PortableLexicalDocument = {
  id: string;
  kind: string;
  technical_name: string;
  title: string;
  search_text: string;
  table_name?: string;
  field_name?: string;
  field_text?: string;
  table_text?: string;
  data_element?: string;
  data_element_text?: string;
  domain?: string;
  domain_text?: string;
  append_include?: string | boolean | null;
  source_path: string;
  code_summary?: string;
};

/** lexical-index/token_postings.jsonl */
export type PortableTokenPosting = {
  token: string;
  document_ids: string[];
};

/** graph-index/nodes.jsonl */
export type PortableGraphNode = {
  node_id: string;
  project_id: string;
  system_id: string;
  object_type: string;
  object_name: string;
  authoritative_existence?: boolean;
  code_usage?: boolean;
};

/** graph-index/edges.jsonl */
export type PortableGraphEdge = {
  edge_id: string;
  project_id: string;
  system_id: string;
  from_node_id: string;
  to_node_id: string;
  relation_type: string;
  occurrence_count: number;
  evidence_class: "authoritative" | "code_derived" | "unresolved" | string;
  authoritative: boolean;
  resolution?: string;
};

/** evidence-store/documents.jsonl — SearchDocument-compatible; paths relative */
export type PortableEvidenceDocument = {
  document_id: string;
  source_key: string;
  project_id: string;
  system_id: string;
  content_hash: string;
  source_path?: string;
  knowledge_unit_type: string;
  object_type: string;
  object_name: string;
  subobject_name: string;
  title: string;
  technical_summary: string;
  business_purpose: string;
  facts: string[];
  inferences: string[];
  tables_read: string[];
  tables_written: string[];
  called_methods: string[];
  called_functions: string[];
  hardcoded_values: string[];
  evidence: Array<{
    statement_type: string;
    text?: string;
    lines?: Array<{ line?: number; quote?: string }>;
  }>;
  entities: Array<{ kind: string; name: string; normalized?: string }>;
  relations: Array<{
    relation_type: string;
    from_type?: string;
    from_name?: string;
    to_type?: string;
    to_name?: string;
  }>;
  confidence: number | null;
  search_text: string;
  metadata: Record<string, unknown>;
  analysis_version?: string;
  source_system?: string;
  source_type?: string;
  created_at?: string;
  updated_at?: string;
};

/** vector-index/refs.jsonl — thin refs only; embeddings stay in embeddings/ */
export type PortableVectorRef = {
  document_id: string;
  source_key: string;
  content_hash: string;
  dimensions: number;
};

/** vector-index/manifest.json */
export type PortableVectorManifest = {
  schema_version: typeof PORTABLE_INDEX_VERSION;
  project_id: string;
  system_id: string;
  /** Relative to project root */
  embeddings_relative_path: string;
  embedding_model: string;
  embedding_version: string;
  dimensions: number;
  ref_count: number;
  note: string;
};

/** code-usage postings for expand without scanning full code_units at ask time */
export type PortableCodeUsagePosting = {
  token: string;
  hits: Array<{
    source_key: string;
    zone: string;
    object_name: string;
    method_or_routine: string;
    snippet: string;
  }>;
};
