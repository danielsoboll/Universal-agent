/**
 * Generic cross-source enrichment after a confirmed technical seed.
 * No object-name hardcoding — only deterministic relations that already exist.
 */
export type FieldSeedRef = {
  /** Raw confirmed seed, e.g. ZZ_VLAGER or KNVV-ZZ_VLAGER */
  seed: string;
  table_name: string | null;
  field_name: string;
};

export type FieldValueObservation = {
  value: string;
  count: number;
};

export type MasterDataInstanceSample = {
  owner_entity_id: string;
  kunnr: string | null;
  name1: string | null;
  name2: string | null;
  vkorg: string | null;
  vtweg: string | null;
  spart: string | null;
  value: string;
  source_key: string;
  relative_source_path: string;
};

export type CodeUsageSample = {
  relation: string;
  object_name: string;
  subobject_name: string;
  source_key: string;
  relative_source_path: string;
};

export type ConfigNeighborSample = {
  object_name: string;
  object_type: string;
  relation_type: string;
  node_id: string;
};

export type FieldSeedEnrichment = {
  seed: FieldSeedRef;
  ddic: {
    table_name: string | null;
    field_name: string;
    description: string | null;
    data_element: string | null;
    domain: string | null;
    entity_id: string | null;
    source_key: string | null;
  } | null;
  observed_values: FieldValueObservation[];
  master_instances: {
    total_attributes: number;
    distinct_owners: number;
    distinct_customers: number;
    vkorg_dist: FieldValueObservation[];
    vtweg_dist: FieldValueObservation[];
    spart_dist: FieldValueObservation[];
    samples: MasterDataInstanceSample[];
  };
  code_usage: {
    total: number;
    by_relation: Record<string, number>;
    samples: CodeUsageSample[];
  };
  config_neighbors: ConfigNeighborSample[];
  graph_neighbor_names: string[];
  evidence_paths: string[];
};

export type SeedEnrichmentPack = {
  enriched: boolean;
  field_enrichments: FieldSeedEnrichment[];
  confirmed_seeds: string[];
  notes: string[];
};

export type PresentationHint =
  | "how_works"
  | "where_used"
  | "which_instances"
  | "generic";

export type PresentationHintResult = {
  hint: PresentationHint;
  signals: string[];
};
