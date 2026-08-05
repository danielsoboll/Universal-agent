/**
 * planned_rag-only topic grounding + run isolation helpers.
 * Never imported by the direct_rag retrieval path.
 *
 * Purpose: after baseline+subquery fusion, drop candidates that only match a
 * named entity (or prior thematic adjacency) without evidence for the
 * question's topic facet. Generic — no customer-/method-specific hardcoding.
 */

import { randomBytes } from "crypto";
import type { KnowledgeHit } from "@/lib/knowledge/types";
import type { QueryPlan } from "@/lib/knowledge/queryPlanSchema";
import {
  extractQueryEntities,
  type QueryEntityCandidate,
} from "@/lib/knowledge/entityGrounding";
import { extractQueryConcepts } from "@/lib/knowledge/relevanceGate";
import {
  PLANNED_RAG_PLANNER_VERSION,
  computeActiveIndexHash,
} from "@/lib/knowledge/askModeVersions";

export { PLANNED_RAG_PLANNER_VERSION, computeActiveIndexHash };

export type TopicCandidateStatus =
  | "confirmed"
  | "possible"
  | "contradicted"
  | "not_relevant";

export type TopicGroundedHit = KnowledgeHit & {
  topic_status: TopicCandidateStatus;
  topic_reason: string;
  topic_matched: string[];
};

export type TopicExclusion = {
  search_document_id: string;
  source_key: string;
  status: TopicCandidateStatus;
  reason: string;
};

export type PlannedRunDebugLog = {
  run_id: string;
  original_question: string;
  subqueries: Array<{ id: string; query: string }>;
  candidates_before: Array<{
    search_document_id: string;
    source_key: string;
    combined_score: number;
    exact_score: number;
  }>;
  candidates_after: Array<{
    search_document_id: string;
    source_key: string;
    topic_status: TopicCandidateStatus;
  }>;
  excluded: TopicExclusion[];
  final_evidence_ids: string[];
  synthesis_context_ids: string[];
  topic_concepts: string[];
  topic_phrases: string[];
  entity_anchors: string[];
};

export type PlannedRagRunState = {
  run_id: string;
  original_question: string;
  subqueries: Array<{ id: string; query: string }>;
  candidates_before: KnowledgeHit[];
  candidates_after: TopicGroundedHit[];
  excluded: TopicExclusion[];
  evidence_ids: string[];
  synthesis_context_ids: string[];
};

const QUERY_STOPWORDS = new Set(
  [
    "für",
    "welche",
    "welcher",
    "welches",
    "welchen",
    "wo",
    "wie",
    "was",
    "wann",
    "wer",
    "gibt",
    "es",
    "im",
    "in",
    "am",
    "an",
    "auf",
    "aus",
    "bei",
    "zum",
    "zur",
    "zu",
    "vom",
    "von",
    "der",
    "die",
    "das",
    "den",
    "dem",
    "des",
    "ein",
    "eine",
    "einer",
    "eines",
    "und",
    "oder",
    "mit",
    "ohne",
    "nach",
    "über",
    "unter",
    "zwischen",
    "sind",
    "ist",
    "wird",
    "werden",
    "wurde",
    "wurden",
    "haben",
    "hat",
    "kann",
    "können",
    "bitte",
    "sowie",
    "auch",
    "noch",
    "nur",
    "bereits",
    "alle",
    "allem",
    "alles",
    "dieser",
    "diese",
    "dieses",
    "man",
    "sich",
    "nicht",
    "kein",
    "keine",
    "genau",
    "gemacht",
    "machen",
    "bereich",
    "so",
    "erfüllen",
    "anforderungen",
    "anforderung",
    "umgesetzt",
    "umsetzung",
    "funktioniert",
  ].map((w) => w.toLowerCase()),
);

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Lightweight German stem for topic matching (generic suffixes only). */
export function stemTopicToken(s: string): string {
  let n = normalizeToken(s);
  if (n.length < 5) return n;
  const suffixes = [
    "ischen",
    "lichem",
    "lichen",
    "liche",
    "isches",
    "ischer",
    "ische",
    "ischem",
    "ungen",
    "ung",
    "isches",
    "isch",
    "lich",
    "endes",
    "ende",
    "enden",
    "endem",
    "elles",
    "elle",
    "ellen",
    "ellem",
    "heit",
    "keit",
    "em",
    "en",
    "er",
    "es",
    "e",
    "s",
  ];
  for (const suf of suffixes) {
    if (n.endsWith(suf) && n.length - suf.length >= 4) {
      n = n.slice(0, -suf.length);
      break;
    }
  }
  return n;
}

function hitCorpus(hit: KnowledgeHit): string {
  const parts = [
    hit.title,
    hit.source_key,
    hit.snippet,
    hit.object_name,
    hit.object_type,
    hit.subobject_name,
    hit.technical_summary,
    hit.business_purpose,
    hit.knowledge_unit_type,
    ...(hit.facts ?? []),
    ...(hit.inferences ?? []),
    ...(hit.tables_read ?? []),
    ...(hit.tables_written ?? []),
    ...(hit.called_methods ?? []),
    ...(hit.hardcoded_values ?? []),
    ...(hit.evidence_refs ?? []),
    ...(hit.evidence ?? []).flatMap((e) => [
      e.text ?? "",
      ...(e.lines ?? []).map((l) => l.quote ?? ""),
    ]),
    ...(hit.entities ?? []).map((e) => `${e.kind} ${e.name}`),
    ...(hit.relations ?? []).map(
      (r) =>
        `${r.relation_type ?? ""} ${r.from_name ?? ""} ${r.to_name ?? ""}`,
    ),
  ];
  return parts.join("\n").toLowerCase();
}

function corpusMatchesStem(compact: string, spaced: string, raw: string): boolean {
  const stem = stemTopicToken(raw);
  if (!stem || stem.length < 3) return false;
  if (stem.length >= 4 && compact.includes(stem)) return true;
  const padded = ` ${spaced.replace(/[^a-z0-9]+/g, " ")} `;
  if (padded.includes(` ${stem} `)) return true;
  // Technical ids often concatenate topic roots (e.g. ZVLAGER ↔ lager)
  if (stem.length >= 4 && compact.includes(stem)) return true;
  return false;
}

/** Ordered content tokens from the question (stopwords removed). */
export function extractContentTokens(question: string): string[] {
  const out: string[] = [];
  for (const m of question.match(/[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9_-]{2,}/g) ?? []) {
    const lower = m.toLowerCase();
    const norm = normalizeToken(m);
    if (!norm || QUERY_STOPWORDS.has(lower) || QUERY_STOPWORDS.has(norm)) continue;
    out.push(m);
  }
  return out;
}

/** Adjacent content-token bigrams as topic phrases (e.g. "virtuelles Lager"). */
export function extractTopicPhrases(question: string): string[] {
  const tokens = extractContentTokens(question);
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    const key = `${stemTopicToken(a)} ${stemTopicToken(b)}`;
    if (seen.has(key)) continue;
    // Prefer phrases where at least one side is longer / more topical
    if (stemTopicToken(a).length < 4 && stemTopicToken(b).length < 4) continue;
    seen.add(key);
    phrases.push(`${a} ${b}`);
  }
  return phrases;
}

export function splitEntityAndTopicConcepts(params: {
  question: string;
  plan?: QueryPlan | null;
}): {
  entities: QueryEntityCandidate[];
  entity_anchors: string[];
  topic_concepts: string[];
  topic_phrases: string[];
} {
  const entities = extractQueryEntities(params.question, params.plan);
  const entityNorms = new Set(
    entities.map((e) => stemTopicToken(e.normalized_query_entity || e.query_entity)),
  );
  const concepts = extractQueryConcepts(params.question);
  // Only ALLCAPS / identifier-like concepts become extra entity anchors.
  // German nouns (Lager, Farbe, …) stay topic candidates — do not treat Title Case as entity.
  for (const c of concepts) {
    if (/^[A-Z]{2,}[A-Z0-9]*$/.test(c) || /[_/-]/.test(c)) {
      entityNorms.add(stemTopicToken(c));
    }
  }
  // Brand-/name-like tokens: Capitalized after von/für/bei/kunde/…
  for (const c of concepts) {
    if (!/^[A-ZÄÖÜ][a-zäöüß]{2,}/.test(c)) continue;
    const stem = stemTopicToken(c);
    if (entityNorms.has(stem)) continue;
    const re = new RegExp(
      `(?:von|für|bei|kunde|kunden|marke|partner)\\s+${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    );
    if (re.test(params.question)) {
      entityNorms.add(stem);
    }
  }

  const topic_concepts: string[] = [];
  const seen = new Set<string>();
  for (const c of concepts) {
    const stem = stemTopicToken(c);
    if (!stem || entityNorms.has(stem)) continue;
    if (stem.length < 4 && !/[_/-]/.test(c)) continue;
    if (
      QUERY_STOPWORDS.has(c.toLowerCase()) ||
      QUERY_STOPWORDS.has(normalizeToken(c)) ||
      QUERY_STOPWORDS.has(stem)
    ) {
      continue;
    }
    if (seen.has(stem)) continue;
    seen.add(stem);
    topic_concepts.push(c);
  }

  const topic_phrases = extractTopicPhrases(params.question).filter((p) => {
    const [a, b] = p.split(" ");
    // Drop phrases that are purely entity+entity
    return !(entityNorms.has(stemTopicToken(a ?? "")) && entityNorms.has(stemTopicToken(b ?? "")));
  });

  return {
    entities,
    entity_anchors: [...entityNorms],
    topic_concepts,
    topic_phrases,
  };
}

function phraseMatchesCorpus(
  phrase: string,
  compact: string,
  spaced: string,
): boolean {
  const parts = phrase.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((p) => corpusMatchesStem(compact, spaced, p));
}

/**
 * Create a fresh isolated planned_rag run id. No shared/global state.
 */
export function createPlannedRunId(): string {
  return `pr_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** Fresh empty run container — never mutate a previous run object. */
export function createPlannedRagRunState(
  question: string,
  runId?: string,
): PlannedRagRunState {
  return {
    run_id: runId ?? createPlannedRunId(),
    original_question: question,
    subqueries: [],
    candidates_before: [],
    candidates_after: [],
    excluded: [],
    evidence_ids: [],
    synthesis_context_ids: [],
  };
}

/**
 * Topic-ground fused planned_rag candidates against the *current* question only.
 * Entity-only matches are not_relevant when a separable topic facet exists.
 */
export function groundPlannedCandidates(params: {
  run_id: string;
  question: string;
  plan?: QueryPlan | null;
  candidates: KnowledgeHit[];
}): {
  run_id: string;
  kept: TopicGroundedHit[];
  excluded: TopicExclusion[];
  topic_concepts: string[];
  topic_phrases: string[];
  entity_anchors: string[];
} {
  const split = splitEntityAndTopicConcepts({
    question: params.question,
    plan: params.plan,
  });
  const hasTopicFacet =
    split.topic_concepts.length > 0 || split.topic_phrases.length > 0;
  const hasEntityFacet = split.entity_anchors.length > 0;

  const kept: TopicGroundedHit[] = [];
  const excluded: TopicExclusion[] = [];

  // No separable topic facet → do not over-filter (identifier / single-aspect Qs)
  if (!hasTopicFacet) {
    for (const hit of params.candidates) {
      kept.push({
        ...hit,
        topic_status: "confirmed",
        topic_reason: "Kein separates Topic-Facet in der Frage; Treffer unverändert.",
        topic_matched: [],
      });
    }
    return {
      run_id: params.run_id,
      kept,
      excluded,
      topic_concepts: split.topic_concepts,
      topic_phrases: split.topic_phrases,
      entity_anchors: split.entity_anchors,
    };
  }

  for (const hit of params.candidates) {
    const raw = hitCorpus(hit);
    const compact = normalizeToken(raw);
    const spaced = raw
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");

    const matchedTopics: string[] = [];
    for (const phrase of split.topic_phrases) {
      if (phraseMatchesCorpus(phrase, compact, spaced)) {
        matchedTopics.push(phrase);
      }
    }
    for (const c of split.topic_concepts) {
      if (corpusMatchesStem(compact, spaced, c)) {
        matchedTopics.push(c);
      }
    }

    const matchedEntities: string[] = [];
    for (const e of split.entities) {
      if (corpusMatchesStem(compact, spaced, e.query_entity)) {
        matchedEntities.push(e.query_entity);
      }
    }
    // Proper-noun anchors not in extractQueryEntities
    for (const anchor of split.entity_anchors) {
      if (anchor.length >= 4 && compact.includes(anchor)) {
        if (!matchedEntities.some((m) => stemTopicToken(m) === anchor)) {
          matchedEntities.push(anchor);
        }
      }
    }

    const uniqueTopics = [...new Set(matchedTopics)];
    const uniqueEntities = [...new Set(matchedEntities)];
    // Topic stems that are not named-entity anchors (the actual subject matter)
    const contentTopicStems = new Set(
      [...split.topic_concepts, ...split.topic_phrases.flatMap((p) => p.split(/\s+/))]
        .map((t) => stemTopicToken(t))
        .filter((s) => s.length >= 4 && !split.entity_anchors.includes(s)),
    );
    const matchedContentTopicStems = new Set(
      uniqueTopics
        .flatMap((t) => t.split(/\s+/).map((p) => stemTopicToken(p)))
        .filter((s) => contentTopicStems.has(s)),
    );
    const matchedPhrase = uniqueTopics.some((t) => {
      if (!t.includes(" ")) return false;
      // Phrase counts only if it includes at least one non-entity content stem
      return t
        .split(/\s+/)
        .map((p) => stemTopicToken(p))
        .some((s) => contentTopicStems.has(s) && matchedContentTopicStems.has(s));
    });

    let status: TopicCandidateStatus;
    let reason: string;

    // When the question has a separable content topic (e.g. virtuell+lager),
    // entity-only evidence is never enough — classic context-leak pattern.
    const requiresContentTopic = contentTopicStems.size > 0;
    const hasContentTopic = matchedContentTopicStems.size > 0;

    if (requiresContentTopic && !hasContentTopic) {
      status = "not_relevant";
      reason =
        uniqueEntities.length > 0 || uniqueTopics.length > 0
          ? "Nur Entity-/Randtreffer ohne belegbaren Bezug zum Topic-Facet der aktuellen Frage."
          : "Weder Topic- noch Entity-Bezug zur aktuellen Frage belegt.";
    } else if (!hasContentTopic && uniqueTopics.length === 0 && uniqueEntities.length === 0) {
      status = "not_relevant";
      reason = "Weder Topic- noch Entity-Bezug zur aktuellen Frage belegt.";
    } else if (
      matchedPhrase ||
      matchedContentTopicStems.size >= 2 ||
      (hasContentTopic && (uniqueEntities.length > 0 || !hasEntityFacet)) ||
      (hasContentTopic && (hit.exact_score ?? 0) >= 1)
    ) {
      status = "confirmed";
      reason =
        `Topic belegt (${[...matchedContentTopicStems].slice(0, 4).join(", ") || uniqueTopics.slice(0, 4).join(", ")})` +
        (uniqueEntities.length
          ? `; Entity belegt (${uniqueEntities.slice(0, 3).join(", ")})`
          : "");
    } else if (hasContentTopic) {
      status = "possible";
      reason =
        "Topic-Bezug teilweise belegt; Entität der Frage nicht im Treffer nachgewiesen.";
    } else {
      status = "not_relevant";
      reason = "Kein belastbarer Topic-Bezug zur aktuellen Frage.";
    }

    if (status === "not_relevant") {
      excluded.push({
        search_document_id: hit.search_document_id,
        source_key: hit.source_key,
        status,
        reason,
      });
      continue;
    }

    kept.push({
      ...hit,
      topic_status: status,
      topic_reason: reason,
      topic_matched: uniqueTopics,
    });
  }

  // Re-rank: confirmed first, then by existing score
  kept.sort((a, b) => {
    const rank = (s: TopicCandidateStatus) => (s === "confirmed" ? 2 : 1);
    const d = rank(b.topic_status) - rank(a.topic_status);
    if (d !== 0) return d;
    return b.combined_score - a.combined_score;
  });
  const reranked = kept.map((h, i) => ({ ...h, rank: i + 1 }));

  return {
    run_id: params.run_id,
    kept: reranked,
    excluded,
    topic_concepts: split.topic_concepts,
    topic_phrases: split.topic_phrases,
    entity_anchors: split.entity_anchors,
  };
}

/** Hits allowed into synthesis: confirmed as facts; possible as uncertainty only. */
export function synthesisHitsFromTopicGrounding(
  kept: TopicGroundedHit[],
): {
  fact_hits: TopicGroundedHit[];
  uncertainty_hits: TopicGroundedHit[];
  synthesis_hits: TopicGroundedHit[];
} {
  const fact_hits = kept.filter((h) => h.topic_status === "confirmed");
  const uncertainty_hits = kept.filter((h) => h.topic_status === "possible");
  return {
    fact_hits,
    uncertainty_hits,
    synthesis_hits: [...fact_hits, ...uncertainty_hits],
  };
}

export function buildPlannedRunDebugLog(params: {
  state: PlannedRagRunState;
  topic_concepts: string[];
  topic_phrases: string[];
  entity_anchors: string[];
}): PlannedRunDebugLog {
  return {
    run_id: params.state.run_id,
    original_question: params.state.original_question,
    subqueries: params.state.subqueries.map((s) => ({ ...s })),
    candidates_before: params.state.candidates_before.map((h) => ({
      search_document_id: h.search_document_id,
      source_key: h.source_key,
      combined_score: h.combined_score,
      exact_score: h.exact_score,
    })),
    candidates_after: params.state.candidates_after.map((h) => ({
      search_document_id: h.search_document_id,
      source_key: h.source_key,
      topic_status: h.topic_status,
    })),
    excluded: params.state.excluded.map((e) => ({ ...e })),
    final_evidence_ids: [...params.state.evidence_ids],
    synthesis_context_ids: [...params.state.synthesis_context_ids],
    topic_concepts: [...params.topic_concepts],
    topic_phrases: [...params.topic_phrases],
    entity_anchors: [...params.entity_anchors],
  };
}

export function logPlannedRunDebug(log: PlannedRunDebugLog): void {
  console.info(
    "[planned_rag:run]",
    JSON.stringify({
      run_id: log.run_id,
      original_question: log.original_question,
      subqueries: log.subqueries,
      topic_concepts: log.topic_concepts,
      topic_phrases: log.topic_phrases,
      entity_anchors: log.entity_anchors,
      candidates_before: log.candidates_before,
      candidates_after: log.candidates_after,
      excluded: log.excluded,
      final_evidence_ids: log.final_evidence_ids,
      synthesis_context_ids: log.synthesis_context_ids,
    }),
  );
}
