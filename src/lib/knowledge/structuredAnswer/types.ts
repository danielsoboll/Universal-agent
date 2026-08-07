/**
 * Unified structured answer model — produced before any UI rendering.
 * No raw markdown from evidence dumps.
 */

export type ClaimStatus =
  | "AUTHORITATIVE"
  | "CODE_DERIVED"
  | "INFERRED"
  | "UNSUPPORTED";

export type StructuredClaim = {
  claim_text: string;
  claim_status: ClaimStatus;
  evidence_ids: string[];
  confidence: number;
  source_types: string[];
};

export type StructuredProcessStep = {
  text: string;
  technical_refs: string[];
  evidence_ids: string[];
  from_analysis: boolean;
};

export type StructuredEntity = {
  id: string;
  entity_type: string;
  name: string;
  role: string | null;
  rationale: string | null;
  matched_methods: string[];
  attributes: Record<string, string | number | boolean | null>;
};

export type StructuredEvidenceCoverage = {
  sufficient: boolean;
  missing: string[];
  authoritative_objects: number;
  technical_anchors: number;
  code_units: number;
  process_steps: number;
};

export type StructuredDiscarded = {
  id: string;
  display: string;
  reason: string;
};

export type StructuredAnswerDiagnostics = {
  seeds: string[];
  query_terms: string[];
  candidates_before: number | null;
  candidates_after: number | null;
  claims_by_status: Record<ClaimStatus, number>;
  unsupported_discarded: number;
};

export type StructuredAnswer = {
  answer_type: string;
  summary: string;
  confirmed_facts: StructuredClaim[];
  derived_findings: StructuredClaim[];
  process_steps: StructuredProcessStep[];
  entities: StructuredEntity[];
  missing_information: string[];
  discarded_candidates: StructuredDiscarded[];
  evidence_coverage: StructuredEvidenceCoverage;
  diagnostics: StructuredAnswerDiagnostics;
};
