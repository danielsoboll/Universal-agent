/**
 * Portable literal / code exact-index types.
 * Index = Auffindbarkeit. Evidence Store / source_key = Beweis.
 * Kein Original-Source-Code im Index.
 */

export type PortableLiteralType =
  | "string"
  | "numeric"
  | "char"
  | "message_type"
  | "idoc_type"
  | "transaction"
  | "function_module"
  | "unknown";

/** Hint only — never a fachliche Aussage ohne Evidence. */
export type PortableLiteralCandidateRole =
  | "material_number"
  | "customer_number"
  | "vendor_number"
  | "plant"
  | "sales_org"
  | "distr_channel"
  | "division"
  | "company_code"
  | "storage_location"
  | "order_type"
  | "condition_type"
  | "message_type"
  | "idoc_type"
  | "transaction_code"
  | "function_module"
  | "generic_literal";

export type PortableLiteralRecord = {
  literal_id: string;
  project_id: string;
  system_id: string;
  literal_value: string;
  normalized_value: string;
  literal_type: PortableLiteralType;
  /** DDIC-/Technikfelder, an die das Literal gebunden erscheint (z. B. MATNR). */
  bound_fields: string[];
  /** Kontext-Tokens aus dem Statement (ohne Source-Duplikat). */
  context_tokens: string[];
  /** Mögliche Rollen — nur Index-Hinweis, kein Claim. */
  candidate_roles: PortableLiteralCandidateRole[];
  object_type: string;
  object_name: string;
  program_or_include?: string;
  class_name?: string;
  method_or_routine?: string;
  code_unit_id: string;
  source_key: string;
  /** Relativ zu P01 */
  source_path: string;
  line_start: number | null;
  line_end: number | null;
  /** Kurzer Statement-Kontext (≤220 Zeichen), kein voller Source. */
  statement_preview: string;
  in_comment: boolean;
  content_hash: string;
};

export type PortableLiteralValuePosting = {
  normalized_value: string;
  literal_ids: string[];
  /** Distinct bound fields observed for this value */
  bound_fields: string[];
  occurrence_count: number;
};

export type PortableLiteralFieldPosting = {
  field_name: string;
  normalized_values: string[];
  occurrence_count: number;
};
