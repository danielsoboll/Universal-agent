/**
 * Inventory & aggregation resolver — types.
 * Deterministic set/list answers for message/output configuration.
 */

export type InventoryIntent =
  | "INVENTORY_AND_AGGREGATION"
  | "NOT_INVENTORY";

export type InventoryEntityDomain =
  | "DELIVERY_OUTPUT"
  | "OUTPUT_GENERIC"
  | "UNKNOWN";

export type InventoryRequestedFilter =
  | "IDOC_OR_EDI"
  | "ALL_MEDIA"
  | "NONE";

export type InventoryRequestedOutput =
  | "total_count"
  | "filtered_count"
  | "complete_list"
  | "processing_chain";

export type InventoryQueryClassification = {
  intent: InventoryIntent;
  entity_domain: InventoryEntityDomain;
  requested_filter: InventoryRequestedFilter;
  requested_output: InventoryRequestedOutput[];
  matched_cues: string[];
};

export type ChainLinkStatus =
  | "direct"
  | "via_program"
  | "via_partner_profile"
  | "unresolved";

/** Human-readable evidence status for UI cards. */
export type EvidenceStatusLabel =
  | "vollständige IDoc-Kette belegt"
  | "EDI-Verarbeitung belegt"
  | "Message Type nicht eindeutig verbunden"
  | "IDoc-Basistyp nicht eindeutig verbunden"
  | "kein EDI-Medium";

export type ApplicationSelectionConfidence = "HIGH" | "MEDIUM" | "LOW";

export type ApplicationSelection = {
  selected_application: string | null;
  selection_method: "output_type_text_delivery_density";
  score: number;
  matching_text_count: number;
  total_text_count: number;
  confidence: ApplicationSelectionConfidence;
  reason: string;
};

export type OutputInventoryRow = {
  application: string;
  output_type: string;
  description: string | null;
  transmission_medium: string;
  medium_text: string;
  medium_resolution: string;
  program: string | null;
  routine: string | null;
  form: string | null;
  /** Distinct key: app|output|medium|program|routine */
  distinct_key: string;
  /** Medium 6 / fachlich EDI */
  is_edi_medium: boolean;
  /** Broader EDI/IDoc incl. ALE — legacy */
  is_edi_or_idoc_medium: boolean;
  message_type: string | null;
  idoc_type: string | null;
  idoc_extension: string | null;
  partner_profiles: string[];
  chain_status: ChainLinkStatus;
  chain_note: string | null;
  evidence_status: EvidenceStatusLabel;
  chain_complete: boolean;
  evidence: {
    output_source: string;
    processing_source: string;
    text_source: string | null;
    relation_sources: string[];
  };
};

export type InventoryAggregation = {
  total_output_types: number;
  /** Distinct output types with NACHA=6 / EDI */
  edi_medium_output_types: number;
  other_media_output_types: number;
  medium_distribution: Array<{ medium: string; medium_text: string; count: number }>;
  fully_resolved_chains: number;
  unresolved_edi_chains: number;
  resolved_message_type_count: number;
  resolved_idoc_type_count: number;
};

/** Compact card item for mobile UI — no markdown tables. */
export type InventoryCardItem = {
  output_type: string;
  description: string | null;
  medium: string;
  medium_text: string;
  program: string | null;
  routine: string | null;
  message_type: string | null;
  idoc_type: string | null;
  idoc_extension: string | null;
  evidence_status: EvidenceStatusLabel;
  chain_complete: boolean;
};

export type InventoryAnswerSummary = {
  selected_application: string | null;
  application_selection: ApplicationSelection;
  total_output_types: number;
  edi_medium_count: number;
  resolved_message_type_count: number;
  resolved_idoc_type_count: number;
  fully_resolved_chain_count: number;
  unresolved_chain_count: number;
  text: string;
};

/** Structured inventory payload for frontend rendering. */
export type InventoryAnswerView = {
  summary: InventoryAnswerSummary;
  filtered_items: InventoryCardItem[];
  other_items: InventoryCardItem[];
  unresolved_items: InventoryCardItem[];
  sources: string[];
};

export type InventoryDiagnostics = {
  intent: InventoryQueryClassification;
  delivery_application: string | null;
  delivery_application_reason: string;
  application_selection: ApplicationSelection | null;
  total_output_types: number;
  medium_distribution: Array<{ medium: string; medium_text: string; count: number }>;
  edi_filtered_output_types: string[];
  resolved_message_types: string[];
  resolved_idoc_types: string[];
  unresolved_chains: Array<{ output_type: string; note: string }>;
  sources: string[];
  duration_ms: number;
  first_five_cards: InventoryCardItem[];
};

export type InventoryAggregationResult = {
  used: boolean;
  classification: InventoryQueryClassification;
  application: string | null;
  application_reason: string;
  application_selection: ApplicationSelection | null;
  rows: OutputInventoryRow[];
  /** Rows after requested_filter (EDI medium 6). */
  filtered_rows: OutputInventoryRow[];
  /** Non-EDI rows of the same application (collapsed Zusatzinfo). */
  other_media_rows: OutputInventoryRow[];
  aggregation: InventoryAggregation;
  /** Short prose summary only — never markdown tables. */
  summary_sentence: string;
  /** Structured UI payload. */
  answer_view: InventoryAnswerView | null;
  /** @deprecated Prefer answer_view; kept as summary-only text. */
  answer_markdown: string;
  diagnostics: InventoryDiagnostics;
  sources: string[];
  duration_ms: number;
};
