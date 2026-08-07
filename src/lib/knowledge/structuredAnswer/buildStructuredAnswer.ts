/**
 * Map orchestration result → StructuredAnswer (single product answer object).
 * Reuses inventory / entity-list / process views; never invents facts.
 */
import type { AskOrchestrationResult } from "@/lib/knowledge/askOrchestration/runAskOrchestration";
import type { VerifiedClaim } from "@/lib/knowledge/askOrchestration/claimVerifier";
import {
  cleanEntityName,
  isDisplayableEntityName,
  toStructuredClaim,
} from "./claimContract";
import { buildFailClosedSummary } from "./failClosedSummary";
import type {
  ClaimStatus,
  StructuredAnswer,
  StructuredDiscarded,
  StructuredEntity,
  StructuredProcessStep,
} from "./types";

function claimsByStatus(claims: VerifiedClaim[]): Record<ClaimStatus, number> {
  const out: Record<ClaimStatus, number> = {
    AUTHORITATIVE: 0,
    CODE_DERIVED: 0,
    INFERRED: 0,
    UNSUPPORTED: 0,
  };
  for (const c of claims) out[c.strength] += 1;
  return out;
}

function entitiesFromInventory(
  orch: AskOrchestrationResult,
): StructuredEntity[] {
  const view = orch.inventory_answer;
  if (!view) return [];
  const out: StructuredEntity[] = [];
  for (const item of view.filtered_items) {
    const name = cleanEntityName(item.output_type);
    if (!isDisplayableEntityName(name)) continue;
    out.push({
      id: `inv:${name}|${item.medium}`,
      entity_type: "OUTPUT_TYPE",
      name,
      role: item.medium === "6" || /edi/i.test(item.medium_text) ? "EDI" : item.medium_text || item.medium,
      rationale: item.evidence_status,
      matched_methods: [],
      attributes: {
        medium: item.medium,
        program: item.program,
        routine: item.routine,
        message_type: item.message_type,
        idoc_type: item.idoc_type,
        chain_complete: item.chain_complete,
      },
    });
  }
  return out;
}

function entitiesFromEntityList(
  orch: AskOrchestrationResult,
): StructuredEntity[] {
  const view = orch.entity_list_answer;
  if (!view) return [];
  const out: StructuredEntity[] = [];
  for (const item of [
    ...view.primary_items,
    ...view.supporting_items,
    ...view.unclear_items,
  ]) {
    const name = cleanEntityName(item.entity_name);
    if (!isDisplayableEntityName(name)) continue;
    out.push({
      id: `el:${item.entity_type}:${name}`,
      entity_type: item.entity_type,
      name,
      role: item.role_label,
      rationale: item.rationale,
      matched_methods: item.matched_methods.filter(isDisplayableEntityName),
      attributes: {
        role: item.role,
        occurrence_count: item.occurrence_count,
        direct_hits: item.direct_hits,
        graph_distance: item.graph_distance,
        evidence_status: item.evidence_status,
      },
    });
  }
  return out;
}

function entitiesFromHardcodedValues(
  orch: AskOrchestrationResult,
): StructuredEntity[] {
  const view = orch.hardcoded_value_answer;
  if (!view) return [];
  const out: StructuredEntity[] = [];
  for (const m of view.materials) {
    const name = cleanEntityName(m.material_number);
    if (!isDisplayableEntityName(name)) continue;
    const locs = [
      ...new Set(
        m.occurrences
          .filter((o) => o.active_code)
          .map((o) =>
            o.unit_name && o.unit_name !== o.object_name
              ? `${o.object_name}->${o.unit_name}`
              : o.object_name,
          ),
      ),
    ].slice(0, 12);
    out.push({
      id: `hc:matnr:${m.material_number_internal}`,
      entity_type: "MATERIAL_NUMBER",
      name,
      role: m.process_label ?? "hart codiert",
      rationale: [
        m.condition_summary,
        m.effect_summary,
        m.evidence_status,
      ]
        .filter(Boolean)
        .join(" · "),
      matched_methods: locs,
      attributes: {
        occurrence_count: m.occurrence_count,
        claim_status: m.claim_status,
        evidence_status: m.evidence_status,
        process: m.process_label,
        condition: m.condition_summary,
        effect: m.effect_summary,
      },
    });
  }
  return out;
}

function entitiesFromProcess(orch: AskOrchestrationResult): StructuredEntity[] {
  const view = orch.process_answer_view;
  if (!view) return [];
  const out: StructuredEntity[] = [];
  for (const a of view.technical_anchors) {
    const name = cleanEntityName(a.object_name);
    if (!isDisplayableEntityName(name)) continue;
    out.push({
      id: `anchor:${a.object_type}:${name}`,
      entity_type: a.object_type,
      name,
      role: "technischer Anker",
      rationale: null,
      matched_methods: [],
      attributes: { role: a.role },
    });
  }
  for (const p of view.participants) {
    const name = cleanEntityName(p.object_name);
    if (!isDisplayableEntityName(name)) continue;
    if (out.some((e) => e.name === name)) continue;
    out.push({
      id: `part:${p.object_type}:${name}`,
      entity_type: p.object_type,
      name,
      role: "beteiligt",
      rationale: null,
      matched_methods: [],
      attributes: {},
    });
  }
  // Roll method findings under parent class
  const byClass = new Map<string, string[]>();
  for (const f of view.technical_findings) {
    const cls = cleanEntityName(f.object_name);
    const meth = f.unit_name ? cleanEntityName(f.unit_name) : "";
    if (!isDisplayableEntityName(cls) || !meth) continue;
    const list = byClass.get(cls) ?? [];
    if (!list.includes(meth)) list.push(meth);
    byClass.set(cls, list);
  }
  for (const [cls, methods] of byClass) {
    const existing = out.find((e) => e.name === cls);
    if (existing) {
      existing.matched_methods = [
        ...new Set([...existing.matched_methods, ...methods]),
      ];
    } else {
      out.push({
        id: `find:${cls}`,
        entity_type: "CLASS",
        name: cls,
        role: "technische Fundstelle",
        rationale: null,
        matched_methods: methods,
        attributes: {},
      });
    }
  }
  for (const f of view.tables_fields_config) {
    const name = cleanEntityName(f.object_name);
    if (!isDisplayableEntityName(name)) continue;
    out.push({
      id: `cfg:${f.object_type}:${name}`,
      entity_type: f.object_type,
      name,
      role: f.role,
      rationale: null,
      matched_methods: [],
      attributes: {},
    });
  }
  return out;
}

function processStepsFromView(
  orch: AskOrchestrationResult,
): StructuredProcessStep[] {
  const view = orch.process_answer_view;
  if (!view) return [];
  return view.process_steps
    .filter((s) => s.from_analysis && s.text.trim())
    .map((s) => ({
      text: s.text,
      technical_refs: s.technical_refs,
      evidence_ids: s.source_keys,
      from_analysis: true,
    }));
}

function discardedFromOrch(
  orch: AskOrchestrationResult,
): StructuredDiscarded[] {
  const out: StructuredDiscarded[] = [];
  for (const d of orch.diagnostics.discarded_unsupported_claims) {
    out.push({
      id: `claim:${d.text.slice(0, 40)}`,
      display: d.text,
      reason: d.reason,
    });
  }
  const rg = orch.diagnostics.relevance_gate;
  if (rg) {
    for (const x of rg.excluded_shared_token_only.slice(0, 40)) {
      out.push({
        id: `gate:${x}`,
        display: x,
        reason: "shared_token_only / Relevance-Gate",
      });
    }
  }
  if (orch.entity_list_answer) {
    for (const f of orch.entity_list_answer.filtered_out_evidence.slice(0, 30)) {
      out.push({
        id: `el-out:${f.kind}:${f.name}`,
        display: `${f.kind}:${f.name}`,
        reason: f.note,
      });
    }
  }
  if (orch.hardcoded_value_answer) {
    for (const e of orch.hardcoded_value_answer.excluded_sample.slice(0, 40)) {
      out.push({
        id: `hc-ex:${e.literal}:${e.reason}`,
        display: e.literal,
        reason: e.reason,
      });
    }
  }
  return out;
}

function baseSummary(orch: AskOrchestrationResult): string {
  if (orch.hardcoded_value_answer?.summary.text) {
    return orch.hardcoded_value_answer.summary.text;
  }
  if (orch.inventory_answer?.summary.text) {
    return orch.inventory_answer.summary.text;
  }
  if (orch.entity_list_answer?.summary.text) {
    return orch.entity_list_answer.summary.text;
  }
  if (orch.process_answer_view?.summary) {
    return orch.process_answer_view.summary;
  }
  return orch.summary || orch.answer_markdown || "";
}

/**
 * Build the product StructuredAnswer from an orchestration result.
 */
export function buildStructuredAnswerFromOrchestration(
  orch: AskOrchestrationResult,
): StructuredAnswer {
  const confirmed_facts = orch.claims
    .filter((c) => c.strength === "AUTHORITATIVE" || c.strength === "CODE_DERIVED")
    .map((c) => toStructuredClaim(c))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  const derived_findings = orch.claims
    .filter((c) => c.strength === "INFERRED")
    .map((c) => toStructuredClaim(c))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  let entities: StructuredEntity[] = [];
  if (orch.intent === "INVENTORY_AND_AGGREGATION") {
    entities = entitiesFromInventory(orch);
  } else if (orch.intent === "ENTITY_LIST") {
    entities = entitiesFromEntityList(orch);
  } else if (orch.intent === "HARDCODED_VALUE_INVENTORY") {
    entities = entitiesFromHardcodedValues(orch);
  } else {
    entities = entitiesFromProcess(orch);
  }

  // OBJECT_LOOKUP / TECHNICAL_TRACE without process view: entities from graph paths
  if (entities.length === 0 && orch.diagnostics.graph_paths.length > 0) {
    const byObj = new Map<string, string[]>();
    for (const p of orch.diagnostics.graph_paths) {
      const name = cleanEntityName(p.object_name);
      if (!isDisplayableEntityName(name)) continue;
      const list = byObj.get(name) ?? [];
      const unit = cleanEntityName(p.unit_name);
      if (unit && unit !== name && !list.includes(unit)) list.push(unit);
      byObj.set(name, list);
    }
    for (const [name, methods] of byObj) {
      entities.push({
        id: `graph:${name}`,
        entity_type: "CODE_OBJECT",
        name,
        role: null,
        rationale: null,
        matched_methods: methods,
        attributes: {},
      });
    }
  }

  const process_steps = processStepsFromView(orch);
  const cov = orch.diagnostics.evidence_coverage;
  const missing_information = [
    ...cov.missing,
    ...(orch.process_answer_view?.open_points ?? []),
    ...(orch.hardcoded_value_answer?.missing_information ?? []),
  ].filter((x, i, a) => a.indexOf(x) === i);

  const discarded_candidates = discardedFromOrch(orch);

  const evidence_coverage = {
    sufficient: cov.sufficient,
    missing: cov.missing,
    authoritative_objects: cov.authoritative_objects,
    technical_anchors: cov.technical_anchors,
    code_units: cov.code_units,
    process_steps: cov.process_steps,
  };

  const summary = buildFailClosedSummary({
    sufficient: cov.sufficient,
    base_summary: baseSummary(orch),
    confirmed: confirmed_facts,
    missing: missing_information,
    answer_type: orch.intent,
  });

  const allClaimsForDiag = [
    ...orch.claims,
    ...orch.diagnostics.discarded_unsupported_claims.map((d) => ({
      text: d.text,
      strength: "UNSUPPORTED" as const,
      kept: false,
      reason: d.reason,
    })),
  ];

  const rg = orch.diagnostics.relevance_gate;

  return {
    answer_type: orch.intent,
    summary,
    confirmed_facts,
    derived_findings,
    process_steps,
    entities,
    missing_information,
    discarded_candidates,
    evidence_coverage,
    diagnostics: {
      seeds: orch.diagnostics.seeds,
      query_terms: rg?.query_terms ?? [],
      candidates_before: rg?.candidates_before ?? null,
      candidates_after: rg?.candidates_after ?? null,
      claims_by_status: claimsByStatus(allClaimsForDiag),
      unsupported_discarded:
        orch.diagnostics.discarded_unsupported_claims.length,
    },
  };
}
