/**
 * Phase 2 — Graph Selector types (diagnostic only).
 */
export type GraphEvidenceClass =
  | "authoritative_existence"
  | "authoritative_config"
  | "usage_relation"
  | "code_usage"
  | "unresolved"
  | "unknown";

export type GraphNode = {
  node_id: string;
  object_type: string;
  name: string;
  identity_key: string;
  system_id: string;
  display_names: string[];
  authoritative_existence: boolean;
  code_usage: boolean;
  attributes: Record<string, unknown>;
};

export type GraphEdge = {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  relation_type: string;
  relation_unified: string;
  occurrence_count: number;
  evidence_class: GraphEvidenceClass;
  authoritative: boolean;
};

export type GraphPathHop = {
  via_edge_id: string;
  relation_type: string;
  relation_unified: string;
  evidence_class: GraphEvidenceClass;
  occurrence_count: number;
  from_node_id: string;
  to_node_id: string;
};

export type CodeUnitCorpus = "classes" | "programs" | "function-modules";

export type CodeUnitRef = {
  source_key: string;
  corpus: CodeUnitCorpus;
  object_name: string;
  unit_name: string;
  unit_type: string;
  object_type: string;
  content_hash?: string;
  source_code?: string;
};

export type CacheStatus =
  | "hit"
  | "miss"
  | "stale"
  | "not_in_class_corpus"
  | "duplicate";

export type SelectedCodeUnit = {
  rank: number;
  source_key: string;
  corpus: CodeUnitCorpus;
  object_name: string;
  unit_name: string;
  unit_type: string;
  seed_node_id: string;
  graph_node_id: string;
  graph_object_type: string;
  distance: number;
  graph_path: GraphPathHop[];
  ranking_reason: string;
  score_components: {
    authoritative: number;
    direct_symbol: number;
    relation_type: number;
    occurrence_count: number;
    distance: number;
    total: number;
  };
  already_analyzed: boolean;
  duplicate: boolean;
  cache_status: CacheStatus;
  cache_reason: string;
  would_need_openai: boolean;
  openai_eligible: boolean;
};

export type EvidenceCoverage = {
  seeds_found: number;
  seeds_requested: string[];
  authoritative_config_nodes: number;
  code_nodes_reached: number;
  selected_code_units: number;
  selected_with_cache_hit: number;
  selected_needing_openai: number;
  held_back_over_cap: number;
  ddic_or_table_nodes: number;
  expansion_over_cap_recommended: boolean;
  expansion_reason: string | null;
  gaps: string[];
};

export type GraphSelectorResult = {
  question: string;
  anchors: string[];
  max_hops: number;
  max_code_units: number;
  seeds: Array<{
    node_id: string;
    object_type: string;
    name: string;
    match: string;
    authoritative_existence: boolean;
  }>;
  selected: SelectedCodeUnit[];
  held_back: SelectedCodeUnit[];
  evidence_coverage: EvidenceCoverage;
  stats: {
    nodes_loaded: number;
    edges_loaded: number;
    code_units_indexed: number;
    candidates_before_cap: number;
  };
};
