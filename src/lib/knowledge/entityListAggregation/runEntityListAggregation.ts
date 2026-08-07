/**
 * ENTITY_LIST resolver — graph hits → rollup → role → structured cards.
 */
import { BOUND_DATA_PROJECT_KEY } from "@/lib/localData/boundProject";
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";
import {
  extractLexicalSeeds,
  type AskIntentClassification,
} from "@/lib/knowledge/askOrchestration/classifyAskIntent";
import { evidenceBudgetFor } from "@/lib/knowledge/askOrchestration/evidenceBudget";
import { runGraphFirstRetrieval } from "@/lib/knowledge/askOrchestration/graphFirstRetrieval";
import { classifyEntityListIntent } from "./classifyEntityListIntent";
import { aggregateEntityList, hitsFromGraph, methodMatchesTopic } from "./aggregateEntities";
import { buildEntityListAnswerView } from "./formatEntityListAnswer";
import { supplementHitsFromCodeIndex } from "./supplementFromCodeIndex";
import type {
  EntityListAggregationResult,
  EntityListQueryClassification,
} from "./types";

function emptyResult(
  classification: EntityListQueryClassification,
  started: number,
  extras?: Partial<EntityListAggregationResult>,
): EntityListAggregationResult {
  return {
    used: false,
    classification,
    answer_view: null,
    summary_sentence: "",
    diagnostics: {
      classification,
      raw_hit_count: 0,
      unique_entities: [],
      primary: [],
      supporting: [],
      unclear: [],
      filtered_out: [],
      duration_ms: Date.now() - started,
    },
    sources: [],
    duration_ms: Date.now() - started,
    ...extras,
  };
}

/** Intent for graph retrieval with topic seeds (no stopword noise). */
function intentForGraph(
  question: string,
  el: EntityListQueryClassification,
): AskIntentClassification {
  const symbols = extractTechnicalSymbols(question).map((s) => s.norm);
  const lexical = extractLexicalSeeds(question).filter(
    (s) =>
      !/^(diese|klasse|klassen|machen|welche|welcher|liste|sind)$/i.test(s),
  );
  return {
    intent: "ENTITY_LIST",
    confidence: 0.9,
    signals: ["entity_list", ...el.matched_cues],
    technical_symbols: symbols,
    lexical_seeds: [...el.topic_seeds, ...lexical].slice(0, 16),
    entity_list: el,
  };
}

export async function runEntityListAggregationResolver(params: {
  question: string;
  projectKey?: string;
}): Promise<EntityListAggregationResult> {
  const started = Date.now();
  const classification = classifyEntityListIntent(params.question);

  if (classification.intent !== "ENTITY_LIST") {
    return emptyResult(classification, started);
  }

  const projectKey = params.projectKey?.trim() || BOUND_DATA_PROJECT_KEY;
  const graphIntent = intentForGraph(params.question, classification);
  const budget = evidenceBudgetFor("ENTITY_LIST");

  const graph = await runGraphFirstRetrieval({
    question: params.question,
    intent: graphIntent,
    budget,
    projectKey,
  });

  const hits = await supplementHitsFromCodeIndex({
    projectKey,
    topic: classification.topic,
    requested_entity_type: classification.requested_entity_type,
    existing: hitsFromGraph({
      graph_paths: graph.graph_paths,
      cached_analyses: graph.cached_analyses,
    }),
  });

  const { items: rawItems, filtered_out, raw_hit_count } = aggregateEntityList({
    hits,
    requested_entity_type: classification.requested_entity_type,
    topic: classification.topic,
    authoritative_nodes: graph.authoritative_nodes,
  });

  // When klare Primärtreffer existieren: Unklar-Noise ohne Themenmethode ausblenden
  const hasPrimary = rawItems.some((i) => i.role === "PRIMARY");
  const items = hasPrimary
    ? rawItems.filter((i) => {
        if (i.role !== "UNCLEAR") return true;
        return i.matched_methods.some((m) =>
          methodMatchesTopic(m, classification.topic, i.entity_name),
        );
      })
    : rawItems;

  const answer_view = buildEntityListAnswerView({
    classification,
    items,
    filtered_out,
    raw_hit_count,
    sources: graph.canonical_sources,
  });

  const duration_ms = Date.now() - started;
  return {
    used: true,
    classification,
    answer_view,
    summary_sentence: answer_view.summary.text,
    sources: graph.canonical_sources,
    duration_ms,
    diagnostics: {
      classification,
      raw_hit_count,
      unique_entities: items.map((i) => i.entity_name),
      primary: items
        .filter((i) => i.role === "PRIMARY")
        .map((i) => i.entity_name),
      supporting: items
        .filter((i) => i.role === "SUPPORTING")
        .map((i) => i.entity_name),
      unclear: items
        .filter((i) => i.role === "UNCLEAR")
        .map((i) => i.entity_name),
      filtered_out: filtered_out.map((f) => `${f.kind}:${f.name}`),
      duration_ms,
    },
  };
}
