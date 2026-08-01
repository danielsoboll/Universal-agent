import type { KnowledgeHit } from "@/lib/knowledge/types";
import type { DomainProfile } from "@/lib/domain/types";
import type { GroundingReport } from "@/lib/knowledge/entityGrounding";

/**
 * Deterministic relevance / evidence gate — runs BEFORE answer synthesis.
 * Prevents answering from only thematically adjacent retrieval hits when
 * central query concepts are not evidenced. Generic — no question-specific
 * vocabulary hardcoding.
 */

export type Answerability =
  | "answerable"
  | "partially_answerable"
  | "insufficient";

export type RelevanceGateResult = {
  answerability: Answerability;
  query_concepts: string[];
  matched_concepts: string[];
  missing_concepts: string[];
  supporting_source_ids: string[];
  contradicting_source_ids: string[];
  similar_but_insufficient_source_ids: string[];
  reason: string;
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
    "jenes",
    "man",
    "sich",
    "nicht",
    "kein",
    "keine",
    "etwas",
    "etwas",
    "spezifische",
    "spezifischen",
    "spezifischer",
    "besondere",
    "besonderen",
    "besonderheiten",
    "anpassungen",
    "anpassung",
    "kunden",
    "kunde",
    // Question / process verbs — not content concepts
    "macht",
    "machen",
    "tut",
    "tun",
    "passiert",
    "geschieht",
    "unterscheidet",
    "unterscheiden",
    "unterschieden",
    "erfolgt",
    "erfolgen",
    "findet",
    "finden",
    "liegt",
    "liegen",
    "betrifft",
    "betreffen",
    "handelt",
    "zeigen",
    "zeigt",
    "erklaert",
    "erklärt",
    "beschreibt",
    "beschreiben",
    "bedeutet",
    "bedeuten",
    "funktioniert",
    "funktionieren",
    "verwendet",
    "verwenden",
    "genutzt",
    "nutzen",
    "interagieren",
    "miteinander",
    "haengen",
    "hängen",
    "zusammen",
    "zusammenhang",
    "zusammenhaengen",
    "zusammenhängen",
  ].map((w) => w.toLowerCase()),
);

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Extract central query concepts from the question text.
 * Prefer technical identifiers and content tokens; drop German stopwords.
 * Domain profile entity-type labels are NOT injected as concepts — only used
 * to keep short technical tokens that look like domain identifiers.
 */
export function extractQueryConcepts(
  question: string,
  _profile?: DomainProfile | null,
): string[] {
  const q = question.trim();
  const concepts: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const cleaned = raw.trim().replace(/^[^\wÄÖÜäöüß]+|[^\wÄÖÜäöüß]+$/g, "");
    if (!cleaned) return;
    const norm = normalizeToken(cleaned);
    if (!norm || seen.has(norm)) return;
    // Keep short tokens only if alphanumeric tech-ish (e.g. alt/neu with Optitool)
    // or acronym length >= 3 after normalize
    if (norm.length < 3 && !/^[a-z]+\d+$/i.test(cleaned)) return;
    if (QUERY_STOPWORDS.has(cleaned.toLowerCase()) || QUERY_STOPWORDS.has(norm)) {
      return;
    }
    seen.add(norm);
    concepts.push(cleaned);
  };

  // Technical identifiers: SET_KONZERNFARBE, ZCL_..., DESADV-style ALLCAPS
  for (const m of q.match(/\b[A-Z][A-Z0-9]*(?:[_/-][A-Z0-9]+)+\b/g) ?? []) {
    push(m);
  }
  for (const m of q.match(/\b[A-Z]{3,}[A-Z0-9]*\b/g) ?? []) {
    push(m);
  }

  // Alphanumeric tokens / words (German)
  for (const m of q.match(/[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9_-]{2,}/g) ?? []) {
    push(m);
  }

  // Contrasting short adjectives when paired with a longer concept already found
  // e.g. "Optitool alt und neu" — keep alt/neu if a longer concept exists
  if (concepts.some((c) => normalizeToken(c).length >= 5)) {
    for (const short of ["alt", "neu", "old", "new"]) {
      if (new RegExp(`\\b${short}\\b`, "i").test(q)) {
        const norm = normalizeToken(short);
        if (!seen.has(norm)) {
          seen.add(norm);
          concepts.push(short);
        }
      }
    }
  }

  return concepts;
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
  ];
  return parts.join("\n").toLowerCase();
}

function isEssentialConcept(c: string): boolean {
  const n = normalizeToken(c);
  if (n.length < 3) return false;
  if (/[_/-]/.test(c)) return true;
  if (/^[A-Z]{2,}[A-Z0-9]*$/.test(c)) return true;
  if (/^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(c) && n.length >= 4) {
    return true;
  }
  if (/^[A-ZÄÖÜ][a-zäöüß]{3,}/.test(c)) return true;
  return false;
}

/** Morphological / tech synonyms for short contrastive query terms (generic). */
function expandConceptVariants(concept: string): string[] {
  const n = normalizeToken(concept);
  const out = new Set<string>([concept, n]);
  if (n === "neu" || n === "new") {
    for (const v of ["neu", "new", "neues", "neuer", "neue", "neuen", "neuem"]) {
      out.add(v);
    }
  }
  if (n === "alt" || n === "old") {
    for (const v of ["alt", "old", "altes", "alter", "alte", "alten", "altem"]) {
      out.add(v);
    }
  }
  return [...out];
}

function conceptMatchesHit(concept: string, compact: string, spaced: string): boolean {
  for (const variant of expandConceptVariants(concept)) {
    const norm = normalizeToken(variant);
    if (!norm) continue;
    if (norm.length >= 4) {
      if (compact.includes(norm)) return true;
      continue;
    }
    // Short tokens: whole-word against spaced corpus (handles FOO_NEW → "new")
    const padded = ` ${spaced.replace(/[^a-z0-9]+/g, " ")} `;
    if (padded.includes(` ${norm} `)) return true;
  }
  return false;
}

function hasSpecificEvidence(hit: KnowledgeHit): boolean {
  if ((hit.facts?.length ?? 0) > 0) return true;
  if ((hit.evidence?.length ?? 0) > 0) return true;
  if ((hit.evidence_refs?.length ?? 0) > 0) return true;
  if ((hit.hardcoded_values?.length ?? 0) > 0) return true;
  if ((hit.snippet?.trim().length ?? 0) >= 40) return true;
  if ((hit.technical_summary?.trim().length ?? 0) >= 40) return true;
  return false;
}

/**
 * When supporting hits already establish the topic on a concrete object
 * (e.g. class/program), include sibling hits of the same object that carry
 * specific evidence — covers vocabulary mismatch (versioned methods without
 * repeating the business name). Only expands; never creates support from scratch.
 */
function expandSupportingViaSharedObject(
  hits: KnowledgeHit[],
  supporting: Set<string>,
  similar: Set<string>,
): void {
  if (supporting.size === 0) return;
  const objectNames = new Set(
    hits
      .filter((h) => supporting.has(h.search_document_id))
      .map((h) => h.object_name?.trim())
      .filter((n): n is string => Boolean(n && n.length >= 3)),
  );
  if (objectNames.size === 0) return;
  for (const hit of hits) {
    if (supporting.has(hit.search_document_id)) continue;
    if (!hit.object_name || !objectNames.has(hit.object_name)) continue;
    if (!hasSpecificEvidence(hit)) continue;
    supporting.add(hit.search_document_id);
    similar.delete(hit.search_document_id);
  }
}

/**
 * Assess whether retrieval hits can answer the question.
 * Score alone is not used as the sole decision.
 */
export function assessRelevanceGate(params: {
  question: string;
  hits: KnowledgeHit[];
  grounding?: GroundingReport | null;
  domainProfile?: DomainProfile | null;
}): RelevanceGateResult {
  const query_concepts = extractQueryConcepts(
    params.question,
    params.domainProfile,
  );
  const matched = new Set<string>();
  const supporting = new Set<string>();
  const similar = new Set<string>();
  const contradicting = new Set<string>();

  if (params.grounding?.has_ungrounded_named_entity) {
    for (const r of params.grounding.results) {
      if (
        r.grounding_status === "contradicted" ||
        r.grounding_status === "not_found"
      ) {
        for (const ref of r.evidence_refs) {
          const rank = Number(ref.match(/^#(\d+)/)?.[1]);
          const hit = params.hits.find((h) => h.rank === rank);
          if (hit) contradicting.add(hit.search_document_id);
        }
      }
    }
  }

  for (const hit of params.hits) {
    const raw = hitCorpus(hit);
    const compact = normalizeToken(raw);
    const spaced = raw
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");

    const hitMatched: string[] = [];
    for (const c of query_concepts) {
      if (conceptMatchesHit(c, compact, spaced)) {
        hitMatched.push(c);
        matched.add(c);
      }
    }

    if (hitMatched.length === 0) {
      similar.add(hit.search_document_id);
      continue;
    }

    const substantial = hitMatched.filter(
      (c) => normalizeToken(c).length >= 4 || isEssentialConcept(c),
    );
    const ok =
      hasSpecificEvidence(hit) &&
      (query_concepts.length <= 1 ||
        substantial.length > 0 ||
        hitMatched.length >= Math.ceil(query_concepts.length * 0.5));

    if (ok) supporting.add(hit.search_document_id);
    else similar.add(hit.search_document_id);
  }

  // Vocabulary-mismatch bridge: same object as an already-supporting hit
  expandSupportingViaSharedObject(params.hits, supporting, similar);

  const matched_concepts = query_concepts.filter((c) =>
    matched.has(c),
  );
  // Prefer reporting missing by original concept strings
  const missing_concepts = query_concepts.filter(
    (c) => !matched.has(c),
  );

  const coverage =
    query_concepts.length === 0
      ? params.hits.some(hasSpecificEvidence)
        ? 1
        : 0
      : matched_concepts.length / query_concepts.length;

  // Named-subject grounding failure → insufficient regardless of lexical coverage
  if (params.grounding?.has_ungrounded_named_entity) {
    return {
      answerability: "insufficient",
      query_concepts,
      matched_concepts,
      missing_concepts: [
        ...missing_concepts,
        ...params.grounding.contradicted_entity_names,
      ],
      supporting_source_ids: [...supporting],
      contradicting_source_ids: [...contradicting],
      similar_but_insufficient_source_ids: [...similar],
      reason:
        "Benannte Entität aus der Frage ist in den Quellen nicht belegt oder widersprochen.",
    };
  }

  if (query_concepts.length === 0) {
    if (params.hits.some(hasSpecificEvidence)) {
      return {
        answerability: "answerable",
        query_concepts,
        matched_concepts,
        missing_concepts,
        supporting_source_ids: params.hits
          .filter(hasSpecificEvidence)
          .map((h) => h.search_document_id),
        contradicting_source_ids: [],
        similar_but_insufficient_source_ids: [],
        reason: "Keine zentralen Query-Konzepte; Treffer mit Evidence vorhanden.",
      };
    }
    return {
      answerability: "insufficient",
      query_concepts,
      matched_concepts,
      missing_concepts,
      supporting_source_ids: [],
      contradicting_source_ids: [],
      similar_but_insufficient_source_ids: params.hits.map(
        (h) => h.search_document_id,
      ),
      reason: "Keine Evidenz mit ausreichender Spezifität.",
    };
  }

  // Essential concepts: technical / proper-noun-like tokens — not question verbs.
  const essential = query_concepts.filter(isEssentialConcept);
  const effectiveEssential =
    essential.length > 0
      ? essential
      : query_concepts.filter((c) => normalizeToken(c).length >= 4);
  const essentialMissing = effectiveEssential.filter((c) => !matched.has(c));
  const essentialCoverage =
    effectiveEssential.length === 0
      ? coverage
      : (effectiveEssential.length - essentialMissing.length) /
        effectiveEssential.length;

  if (supporting.size === 0 || essentialCoverage < 0.34) {
    return {
      answerability: "insufficient",
      query_concepts,
      matched_concepts,
      missing_concepts,
      supporting_source_ids: [],
      contradicting_source_ids: [...contradicting],
      similar_but_insufficient_source_ids: [
        ...new Set([...similar, ...params.hits.map((h) => h.search_document_id)]),
      ],
      reason:
        essentialMissing.length > 0
          ? `Zentrale Query-Konzepte ohne passende Evidence: ${essentialMissing.join(", ")}.`
          : "Nur thematisch ähnliche oder unspezifische Treffer — keine belastbare Beantwortung.",
    };
  }

  if (essentialCoverage < 0.75 || coverage < 0.6) {
    return {
      answerability: "partially_answerable",
      query_concepts,
      matched_concepts,
      missing_concepts,
      supporting_source_ids: [...supporting],
      contradicting_source_ids: [...contradicting],
      similar_but_insufficient_source_ids: [...similar].filter(
        (id) => !supporting.has(id),
      ),
      reason: `Teilweise belegt (${matched_concepts.join(", ") || "—"}); fehlend: ${missing_concepts.join(", ") || "—"}.`,
    };
  }

  return {
    answerability: "answerable",
    query_concepts,
    matched_concepts,
    missing_concepts,
    supporting_source_ids: [...supporting],
    contradicting_source_ids: [...contradicting],
    similar_but_insufficient_source_ids: [...similar].filter(
      (id) => !supporting.has(id),
    ),
    reason: "Zentrale Query-Konzepte sind in den Quellen belegt.",
  };
}

export function hitsByIds(
  hits: KnowledgeHit[],
  ids: string[],
): KnowledgeHit[] {
  const set = new Set(ids);
  return hits.filter((h) => set.has(h.search_document_id));
}
