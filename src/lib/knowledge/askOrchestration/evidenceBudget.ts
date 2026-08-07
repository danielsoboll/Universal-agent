/**
 * Adaptive evidence budgets per ask intent.
 */
import type { AskOrchestrationIntent } from "./classifyAskIntent";

export type EvidenceBudget = {
  intent: AskOrchestrationIntent;
  min_authoritative_objects: number;
  min_technical_anchors: number;
  min_process_steps: number;
  min_code_units: number;
  require_full_enumeration: boolean;
  require_trace_path: boolean;
  allow_top_k_primary: boolean;
  max_new_analyses: number;
};

export function evidenceBudgetFor(
  intent: AskOrchestrationIntent,
): EvidenceBudget {
  switch (intent) {
    case "OBJECT_LOOKUP":
      return {
        intent,
        min_authoritative_objects: 1,
        min_technical_anchors: 0,
        min_process_steps: 0,
        min_code_units: 0,
        require_full_enumeration: false,
        require_trace_path: false,
        allow_top_k_primary: false,
        max_new_analyses: 5,
      };
    case "PROCESS_EXPLANATION":
      return {
        intent,
        min_authoritative_objects: 0,
        min_technical_anchors: 1,
        min_process_steps: 2,
        min_code_units: 1,
        require_full_enumeration: false,
        require_trace_path: false,
        allow_top_k_primary: false,
        max_new_analyses: 20,
      };
    case "INVENTORY_AND_AGGREGATION":
      return {
        intent,
        min_authoritative_objects: 0,
        min_technical_anchors: 0,
        min_process_steps: 0,
        min_code_units: 0,
        require_full_enumeration: true,
        require_trace_path: false,
        allow_top_k_primary: false,
        max_new_analyses: 0,
      };
    case "ENTITY_LIST":
      return {
        intent,
        min_authoritative_objects: 0,
        min_technical_anchors: 1,
        min_process_steps: 0,
        min_code_units: 1,
        require_full_enumeration: false,
        require_trace_path: false,
        allow_top_k_primary: false,
        max_new_analyses: 0,
      };
    case "HARDCODED_VALUE_INVENTORY":
      return {
        intent,
        min_authoritative_objects: 0,
        min_technical_anchors: 0,
        min_process_steps: 0,
        min_code_units: 0,
        require_full_enumeration: true,
        require_trace_path: false,
        allow_top_k_primary: false,
        max_new_analyses: 0,
      };
    case "TECHNICAL_TRACE":
      return {
        intent,
        min_authoritative_objects: 0,
        min_technical_anchors: 1,
        min_process_steps: 0,
        min_code_units: 1,
        require_full_enumeration: false,
        require_trace_path: true,
        allow_top_k_primary: false,
        max_new_analyses: 20,
      };
    case "COMPARISON":
      return {
        intent,
        min_authoritative_objects: 0,
        min_technical_anchors: 2,
        min_process_steps: 0,
        min_code_units: 0,
        require_full_enumeration: false,
        require_trace_path: false,
        allow_top_k_primary: false,
        max_new_analyses: 10,
      };
    default:
      return {
        intent,
        min_authoritative_objects: 0,
        min_technical_anchors: 0,
        min_process_steps: 0,
        min_code_units: 0,
        require_full_enumeration: false,
        require_trace_path: false,
        allow_top_k_primary: true,
        max_new_analyses: 5,
      };
  }
}

export type EvidenceCoverageReport = {
  authoritative_objects: number;
  technical_anchors: number;
  process_steps: number;
  code_units: number;
  has_enumeration: boolean;
  has_trace_path: boolean;
  missing: string[];
  sufficient: boolean;
};

export function assessEvidenceCoverage(params: {
  budget: EvidenceBudget;
  authoritative_objects: number;
  technical_anchors: number;
  process_steps: number;
  code_units: number;
  has_enumeration: boolean;
  has_trace_path: boolean;
}): EvidenceCoverageReport {
  const missing: string[] = [];
  const b = params.budget;
  if (params.authoritative_objects < b.min_authoritative_objects) {
    missing.push(
      `autoritativer Objekttreffer (haben ${params.authoritative_objects}, brauchen ${b.min_authoritative_objects})`,
    );
  }
  if (params.technical_anchors < b.min_technical_anchors) {
    missing.push(
      `technischer Anker (haben ${params.technical_anchors}, brauchen ${b.min_technical_anchors})`,
    );
  }
  if (params.process_steps < b.min_process_steps) {
    missing.push(
      `zusammenhängende Prozessschritte (haben ${params.process_steps}, brauchen ${b.min_process_steps})`,
    );
  }
  if (params.code_units < b.min_code_units) {
    missing.push(
      `Codeeinheit (haben ${params.code_units}, brauchen ${b.min_code_units})`,
    );
  }
  if (b.require_full_enumeration && !params.has_enumeration) {
    missing.push("vollständige Enumeration aus Canonical-Daten");
  }
  if (b.require_trace_path && !params.has_trace_path) {
    missing.push("belegter technischer Pfad (Graph-Hops)");
  }
  return {
    authoritative_objects: params.authoritative_objects,
    technical_anchors: params.technical_anchors,
    process_steps: params.process_steps,
    code_units: params.code_units,
    has_enumeration: params.has_enumeration,
    has_trace_path: params.has_trace_path,
    missing,
    sufficient: missing.length === 0,
  };
}
