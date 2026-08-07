/**
 * ENTITY_LIST aggregation — structured list answers for classes/programs/tables/methods.
 */

export type EntityListIntent = "ENTITY_LIST" | "NOT_ENTITY_LIST";

export type RequestedEntityType =
  | "CLASS"
  | "PROGRAM"
  | "TABLE"
  | "METHOD"
  | "FUNCTION_MODULE"
  | "UNKNOWN";

/** Fachlicher Suchbegriff / Topic — derived from question cues, not hardcoded objects. */
export type EntityListTopic =
  | "EDI_MAPPING"
  | "MAPPING"
  | "EDI"
  | "IDOC"
  | "GENERIC";

export type EntityListDetailDepth =
  | "NAMES_ONLY"
  | "WITH_METHODS"
  | "WITH_EVIDENCE";

export type EntityListRole = "PRIMARY" | "SUPPORTING" | "UNCLEAR";

export type EntityListQueryClassification = {
  intent: EntityListIntent;
  requested_entity_type: RequestedEntityType;
  topic: EntityListTopic;
  /** Human-readable topic label for summary text. */
  topic_label: string;
  detail_depth: EntityListDetailDepth;
  /** Seeds for graph retrieval (topic terms, not stopwords). */
  topic_seeds: string[];
  matched_cues: string[];
};

export type EntityListRawHit = {
  source_key: string;
  object_type: string;
  object_name: string;
  unit_type: string;
  unit_name: string;
  distance: number;
  path_relations: string[];
  summary: string | null;
  cache_hit: boolean;
};

export type EntityListContextNode = {
  kind: string;
  name: string;
  note: string;
};

export type EntityListCardItem = {
  entity_name: string;
  entity_type: RequestedEntityType;
  role: EntityListRole;
  role_label: string;
  rationale: string;
  matched_methods: string[];
  occurrence_count: number;
  direct_hits: number;
  graph_distance: number | null;
  evidence_sources: string[];
  evidence_status: string;
  context_nodes: EntityListContextNode[];
  hit_kind: "direct" | "graph";
};

export type EntityListAnswerSummary = {
  text: string;
  topic: EntityListTopic;
  topic_label: string;
  requested_entity_type: RequestedEntityType;
  raw_hit_count: number;
  unique_entity_count: number;
  primary_count: number;
  supporting_count: number;
  unclear_count: number;
};

export type EntityListAnswerView = {
  summary: EntityListAnswerSummary;
  primary_items: EntityListCardItem[];
  supporting_items: EntityListCardItem[];
  unclear_items: EntityListCardItem[];
  /** Filtered non-requested types kept as technical evidence only. */
  filtered_out_evidence: Array<{
    kind: string;
    name: string;
    note: string;
  }>;
  sources: string[];
};

export type EntityListDiagnostics = {
  classification: EntityListQueryClassification;
  raw_hit_count: number;
  unique_entities: string[];
  primary: string[];
  supporting: string[];
  unclear: string[];
  filtered_out: string[];
  duration_ms: number;
};

export type EntityListAggregationResult = {
  used: boolean;
  classification: EntityListQueryClassification;
  answer_view: EntityListAnswerView | null;
  summary_sentence: string;
  diagnostics: EntityListDiagnostics;
  sources: string[];
  duration_ms: number;
};
