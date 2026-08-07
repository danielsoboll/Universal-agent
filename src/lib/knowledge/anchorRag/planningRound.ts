/**
 * Optional KI planning round for deep search (after first expansion).
 * Output is structured JSON only — never treat invented names as facts.
 */
import { z } from "zod";
import { getAIProvider } from "@/lib/ai/provider";
import { AI_CONFIG } from "@/lib/ai/config";
import type { QueryUnderstanding } from "@/lib/knowledge/deepSearch/types";
import type { DeepSearchPlanRound, EvidenceGraph } from "./types";

const PlanSchema = z.object({
  answerable_now: z.boolean(),
  known_facts: z.array(z.string()).default([]),
  missing_information: z.array(z.string()).default([]),
  hypotheses_to_verify: z.array(z.string()).default([]),
  next_anchor_queries: z
    .array(
      z.object({
        anchor: z.string(),
        target_types: z.array(z.string()).default([]),
        relations_to_follow: z.array(z.string()).default([]),
        reason: z.string(),
      }),
    )
    .default([]),
});

const SYSTEM = `Du planst die nächste technische Evidenzsuche in einem SAP-Wissensgraphen.
Antworte NUR mit JSON gemäß Schema.
Regeln:
- Keine erfundenen SAP-Objektnamen als Fakten.
- next_anchor_queries nur mit Ankern, die bereits im Graph oder in known_facts vorkommen, oder klar aus der Frage stammen.
- Keine kundenspezifischen Sonderregeln.
- Hypothesen als TO_BE_VERIFIED formulieren, nicht als Wahrheit.`;

export async function runDeepSearchPlanningRound(params: {
  question: string;
  queryUnderstanding: QueryUnderstanding;
  graph: EvidenceGraph;
  availableSourceTypes: string[];
  openQuestions: string[];
}): Promise<{
  plan: DeepSearchPlanRound;
  tokens: { input: number; output: number };
  model: string;
}> {
  const provider = getAIProvider();
  const model = AI_CONFIG.chatModel;
  const nodeSample = params.graph.nodes.slice(0, 40).map((n) => ({
    type: n.type,
    name: n.name,
    exact: n.exact_match,
  }));
  const edgeSample = params.graph.edges.slice(0, 40).map((e) => ({
    relation: e.relation,
    from: e.from,
    to: e.to,
  }));

  const user = JSON.stringify(
    {
      question: params.question,
      query_understanding: {
        intent: params.queryUnderstanding.intent,
        technical_tokens: params.queryUnderstanding.technical_tokens,
        business_concepts: params.queryUnderstanding.business_concepts,
        assumed_object_types: params.queryUnderstanding.assumed_object_types,
      },
      graph_summary: {
        primary_anchors: params.graph.primary_anchors,
        node_count: params.graph.nodes.length,
        edge_count: params.graph.edges.length,
        nodes_sample: nodeSample,
        edges_sample: edgeSample,
      },
      available_source_types: params.availableSourceTypes,
      open_questions: params.openQuestions,
    },
    null,
    2,
  );

  const parsed = await provider.generateStructured({
    schema: PlanSchema,
    schemaName: "deep_search_plan_round",
    system: SYSTEM,
    user,
    model,
  });

  const plan = PlanSchema.parse(parsed) as DeepSearchPlanRound;

  // Safety: drop next anchors that look invented (not in question/graph/tokens)
  const allowed = new Set(
    [
      ...params.queryUnderstanding.technical_tokens,
      ...params.graph.primary_anchors,
      ...params.graph.nodes.map((n) => n.name),
      ...params.question.split(/[^A-Za-z0-9_/]+/),
    ]
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length >= 2),
  );
  plan.next_anchor_queries = plan.next_anchor_queries.filter((q) => {
    const a = q.anchor.trim().toUpperCase();
    if (a.length < 2) return false;
    return (
      allowed.has(a) ||
      [...allowed].some((x) => x.includes(a) || a.includes(x))
    );
  });

  return {
    plan,
    tokens: { input: 0, output: 0 },
    model,
  };
}
