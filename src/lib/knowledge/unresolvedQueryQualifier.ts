/**
 * Unresolved query qualifier / named term — Direct-RAG constraint retention.
 *
 * When a question names a meaningful qualifier (brand/company/…) plus a topic
 * that *is* evidenced, do not silently answer the topic as if the qualifier
 * matched. Generic — no brand-specific vocabulary.
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";
import type { GroundingReport } from "@/lib/knowledge/entityGrounding";
import type { RelevanceGateResult } from "@/lib/knowledge/relevanceGate";
import { extractNamedExternalEntities } from "@/lib/knowledge/searchBudget/extractNamedExternalEntity";

export type UnresolvedQueryQualifier = {
  raw: string;
  normalized: string;
  kind: string;
};

export type UnresolvedQueryQualifierAssessment = {
  /** Named non-technical terms from the question that lack evidence. */
  unresolved: UnresolvedQueryQualifier[];
  /** Named terms that appear grounded or mentioned in hits. */
  resolved: UnresolvedQueryQualifier[];
  /** Topic / technical evidence exists independently of the qualifier. */
  topic_evidence_present: boolean;
  /** True when topic evidence exists AND at least one qualifier is unresolved. */
  apply_partial_framing: boolean;
  disclaimer: string | null;
};

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hitCorpusNormalized(hit: KnowledgeHit): string {
  // Content only — do not treat query-side annotations (matched_terms like
  // "sym:PEPSI") as evidence that the qualifier was found in inventory.
  const parts = [
    hit.title,
    hit.object_name,
    hit.subobject_name,
    hit.source_key,
    hit.snippet,
    hit.technical_summary,
    hit.business_purpose,
    ...(hit.facts ?? []).map((f) =>
      typeof f === "string" ? f : String((f as { text?: string }).text ?? ""),
    ),
    ...(hit.hardcoded_values ?? []),
    ...(hit.entities ?? []).map((e) => e.name),
    ...(hit.evidence ?? []).map((e) =>
      typeof e === "string" ? e : String((e as { text?: string }).text ?? ""),
    ),
  ];
  return normalizeToken(parts.filter(Boolean).join(" "));
}

/** True when the qualifier appears as a whole token in retrieved evidence. */
export function hitsMentionQualifier(
  hits: KnowledgeHit[],
  normalizedQualifier: string,
): boolean {
  const needle = normalizeToken(normalizedQualifier);
  if (!needle || needle.length < 2) return false;
  for (const h of hits) {
    const hay = hitCorpusNormalized(h);
    if (` ${hay} `.includes(` ${needle} `)) return true;
    // Allow glued forms (EDEKA in EDEKA_DOEMELT) for short proper names.
    if (needle.length >= 4 && hay.replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""))) {
      return true;
    }
  }
  return false;
}

function groundingCoversQualifier(
  grounding: GroundingReport | null | undefined,
  normalizedQualifier: string,
): boolean {
  if (!grounding) return false;
  const needle = normalizeToken(normalizedQualifier);
  for (const r of grounding.results) {
    if (normalizeToken(r.query_entity) !== needle) continue;
    if (
      r.grounding_status === "confirmed" ||
      r.grounding_status === "possible"
    ) {
      return true;
    }
  }
  for (const name of grounding.grounded_entity_names) {
    if (normalizeToken(name) === needle) return true;
  }
  return false;
}

function topicEvidencePresent(params: {
  hits: KnowledgeHit[];
  relevanceGate: RelevanceGateResult | null | undefined;
}): boolean {
  const gate = params.relevanceGate;
  if (
    gate &&
    (gate.answerability === "answerable" ||
      gate.answerability === "partially_answerable") &&
    gate.supporting_source_ids.length > 0
  ) {
    return true;
  }
  if (gate && gate.matched_concepts.length > 0) return true;
  // Deterministic seed / config / inventory evidence counts as topic.
  return params.hits.some((h) => {
    if (h.metadata?.seed_enrichment === true) return true;
    if (h.metadata?.config_table_expansion === true) return true;
    if (h.metadata?.exact_authoritative === true) return true;
    const kut = String(h.knowledge_unit_type ?? "").toLowerCase();
    return (
      kut === "master_field" ||
      kut === "table_profile" ||
      kut === "table_row" ||
      kut === "message_idoc_object"
    );
  });
}

/**
 * Assess unresolved named qualifiers vs. available topic evidence.
 */
export function assessUnresolvedQueryQualifiers(params: {
  question: string;
  hits: KnowledgeHit[];
  grounding?: GroundingReport | null;
  relevanceGate?: RelevanceGateResult | null;
}): UnresolvedQueryQualifierAssessment {
  const named = extractNamedExternalEntities(params.question).filter(
    (e) => e.kind !== "technical_symbol",
  );

  const unresolved: UnresolvedQueryQualifier[] = [];
  const resolved: UnresolvedQueryQualifier[] = [];

  for (const e of named) {
    const item: UnresolvedQueryQualifier = {
      raw: e.raw,
      normalized: e.normalized,
      kind: e.kind,
    };
    if (
      groundingCoversQualifier(params.grounding, e.normalized) ||
      hitsMentionQualifier(params.hits, e.normalized)
    ) {
      resolved.push(item);
    } else {
      unresolved.push(item);
    }
  }

  const topic_evidence_present = topicEvidencePresent({
    hits: params.hits,
    relevanceGate: params.relevanceGate,
  });

  const apply_partial_framing =
    unresolved.length > 0 && topic_evidence_present;

  const disclaimer = apply_partial_framing
    ? unresolved.length === 1
      ? `Zum übrigen Fragegegenstand liegen technische Informationen vor. Einen belegten Zusammenhang mit „${unresolved[0]!.raw}“ finde ich in den geladenen Quellen jedoch nicht.`
      : `Zum übrigen Fragegegenstand liegen technische Informationen vor. Einen belegten Zusammenhang mit ${unresolved
          .map((u) => `„${u.raw}“`)
          .join(", ")} finde ich in den geladenen Quellen jedoch nicht.`
    : null;

  return {
    unresolved,
    resolved,
    topic_evidence_present,
    apply_partial_framing,
    disclaimer,
  };
}

/** Prepend qualifier disclaimer; avoid duplicating if already present. */
export function applyUnresolvedQualifierFraming(params: {
  directAnswer: string;
  disclaimer: string;
  unresolved: UnresolvedQueryQualifier[];
}): {
  direct_answer: string;
  open_texts: string[];
} {
  const open_texts = params.unresolved.map(
    (u) =>
      `Nicht belegt: Bezug zu „${u.raw}“ — allgemeines Themenwissen gilt nicht als Nachweis für diese Entität.`,
  );
  const body = params.directAnswer.trim();
  if (!body) {
    return {
      direct_answer: params.disclaimer,
      open_texts,
    };
  }
  if (body.includes(params.disclaimer) || /belegten zusammenhang mit/i.test(body)) {
    return { direct_answer: body, open_texts };
  }
  return {
    direct_answer: `${params.disclaimer}\n\nAllgemeiner / teilweiser Treffer (ohne belegten Qualifier-Bezug):\n${body}`,
    open_texts,
  };
}
