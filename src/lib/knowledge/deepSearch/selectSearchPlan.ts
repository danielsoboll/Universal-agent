/**
 * Map Query Understanding → specialized multi-source plan type + seeds.
 */
import type { QueryUnderstanding } from "@/lib/knowledge/deepSearch/types";
import type { SearchPlanType } from "@/lib/knowledge/multiSourceSearch/types";
import { filterRetrievalConcepts } from "@/lib/knowledge/queryStopwords";

export type SelectedSearchPlan = {
  plan_type: SearchPlanType;
  preferred: QueryUnderstanding["preferred_search_plan"];
  steps: string[];
  seed_concepts: string[];
  seed_synonyms: string[];
  notes: string[];
  /** Do not treat organization names as hard search anchors. */
  soft_context: string[];
  hypotheses_to_verify: string[];
};

export function selectSearchPlan(
  qu: QueryUnderstanding,
): SelectedSearchPlan {
  const notes: string[] = [
    `intent=${qu.intent}`,
    `preferred=${qu.preferred_search_plan}`,
  ];

  let plan_type: SearchPlanType = "GENERIC";
  switch (qu.preferred_search_plan) {
    case "TECHNICAL_SYMBOL_TO_PROCESS":
      plan_type = "TECHNICAL_SYMBOL_TO_PROCESS";
      break;
    case "MASTER_FIELD_TO_PROCESS":
    case "VALUE_TO_FIELD":
      plan_type = "MASTER_FIELD_TO_PROCESS";
      break;
    case "CONTROL_TABLE_TO_PROCESS":
      plan_type = "CONTROL_TABLE_TO_PROCESS";
      break;
    case "ENTITY_USAGE_EXPAND":
    case "TRACE_CHAIN":
    case "IMPACT_FANOUT":
      plan_type =
        qu.technical_tokens.length > 0
          ? "TECHNICAL_SYMBOL_TO_PROCESS"
          : "GENERIC";
      break;
    case "VERIFICATION_CHECK":
      plan_type = qu.business_concepts.length
        ? "MASTER_FIELD_TO_PROCESS"
        : qu.technical_tokens.length
          ? "TECHNICAL_SYMBOL_TO_PROCESS"
          : "GENERIC";
      break;
    default:
      plan_type =
        qu.technical_tokens.length > 0
          ? "TECHNICAL_SYMBOL_TO_PROCESS"
          : qu.business_concepts.length
            ? "MASTER_FIELD_TO_PROCESS"
            : "GENERIC";
  }

  if (
    qu.assumed_object_types.some((a) => a.confidence === "low") &&
    qu.technical_tokens.length > 0
  ) {
    notes.push(
      "Vermuteter Objekttyp hat niedrige Konfidenz — Exact-Symbol hat Vorrang vor Semantik.",
    );
  }
  for (const h of qu.user_hypotheses) {
    notes.push(`Hypothese TO_BE_VERIFIED (kein Fakt): ${h.text.slice(0, 120)}`);
  }

  const dropObjectTypes = qu.technical_tokens.length > 0;
  const business = filterRetrievalConcepts(qu.business_concepts, {
    dropObjectTypeWords: dropObjectTypes,
  });
  const process = filterRetrievalConcepts(qu.process_context, {
    dropObjectTypeWords: false,
  });

  if (dropObjectTypes && qu.assumed_object_types.length > 0) {
    notes.push(
      "Vermutete Objekttypen nur als Kontext — nicht als harte Suchkonzepte (Exact-Symbol hat Vorrang).",
    );
  }

  const seed_concepts = [
    ...business,
    ...process,
    ...qu.technical_tokens,
  ];
  const seed_synonyms = [
    ...qu.technical_tokens,
    ...business.flatMap((c) =>
      c.split(/\s+/).filter((w) => w.length >= 4),
    ),
  ];

  return {
    plan_type,
    preferred: qu.preferred_search_plan,
    steps: qu.search_plan_steps,
    seed_concepts: [...new Set(seed_concepts.map((s) => s.trim()).filter(Boolean))],
    seed_synonyms: filterRetrievalConcepts(
      [...new Set(seed_synonyms.map((s) => s.trim()).filter(Boolean))],
      { dropObjectTypeWords: dropObjectTypes },
    ),
    notes,
    soft_context: [
      ...qu.organization_context,
      ...(dropObjectTypes
        ? qu.assumed_object_types.map((a) => a.type)
        : []),
    ],
    hypotheses_to_verify: qu.user_hypotheses.map((h) => h.text),
  };
}
