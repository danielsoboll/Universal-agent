import type { KnowledgeHit } from "@/lib/knowledge/types";
import type { QueryPlan } from "@/lib/knowledge/queryPlanSchema";

/**
 * Deterministic entity grounding — runs BEFORE answer synthesis.
 *
 * Purpose: a business rule found in evidence about one concrete entity
 * (e.g. one customer number, one material) must never be silently
 * transferred onto a different entity named in the question. This module
 * only does string/structure matching against already-retrieved hits — no
 * new retrieval, no entity-specific logic (no brand/customer names appear
 * anywhere in this file).
 */

export type QueryEntityType =
  | "customer_name"
  | "customer_number"
  | "partner_number"
  | "partner_role"
  | "material"
  | "plant"
  | "identifier"
  | "unknown";

/** Entity types considered "named business subjects" — grounding gates the answer for these. */
const NAMED_SUBJECT_TYPES: ReadonlySet<QueryEntityType> = new Set([
  "customer_name",
  "customer_number",
  "partner_number",
  "partner_role",
  "material",
  "plant",
]);

export type QueryEntityCandidate = {
  query_entity: string;
  entity_type: QueryEntityType;
  normalized_query_entity: string;
};

export type GroundingStatus =
  | "confirmed"
  | "possible"
  | "contradicted"
  | "not_found";

export type EntityGroundingResult = {
  query_entity: string;
  entity_type: QueryEntityType;
  grounding_status: GroundingStatus;
  matched_source_entities: string[];
  evidence_refs: string[];
  reason: string;
};

export type GroundingReport = {
  query_entities: QueryEntityCandidate[];
  results: EntityGroundingResult[];
  /** Any named business subject (customer/partner/material/plant) not confirmed/possible. */
  has_ungrounded_named_entity: boolean;
  /** All named subjects that are confirmed or possible — safe to state entity-specific facts about. */
  grounded_entity_names: string[];
  /** Named subjects that are contradicted or not_found — must not receive transferred rules. */
  contradicted_entity_names: string[];
};

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsWholeToken(haystackNormalized: string, tokenNormalized: string): boolean {
  if (!tokenNormalized) return false;
  return ` ${haystackNormalized} `.includes(` ${tokenNormalized} `);
}

// --- Query entity extraction (generic, question-pattern based) ---------

const CUSTOMER_NAME_PATTERNS: RegExp[] = [
  /besonderheit(?:en)?\s+für\s+(?:den\s+kunden\s+|die\s+kundin\s+)?(.+?)\s*\??$/i,
  /(?:kunde|kunden|marke|partner)\s+([A-Za-zÄÖÜäöüß0-9][\wÄÖÜäöüß\- ]{1,40})\s*\??$/i,
  /für\s+(?:den\s+kunden\s+)?([A-Za-zÄÖÜäöüß][\wÄÖÜäöüß\- ]{1,40})\s*\??$/i,
];

const GENERIC_SUBJECT_PLACEHOLDER =
  /^(ihr system|unser system|das system|den export|die methode)\b/i;

function extractCustomerNameCandidate(question: string): string | null {
  let subject: string | null = null;
  for (const re of CUSTOMER_NAME_PATTERNS) {
    const m = question.trim().match(re);
    if (m?.[1]) {
      subject = m[1].trim().replace(/[?.!]+$/, "").trim();
      break;
    }
  }
  if (!subject || subject.length < 3) return null;
  if (GENERIC_SUBJECT_PLACEHOLDER.test(subject)) return null;
  return subject;
}

/** SAP-style technical identifiers: ALL_CAPS_WITH_UNDERSCORES, min 2 segments or length. */
function extractIdentifierCandidates(question: string): string[] {
  const matches = question.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return [...new Set(matches)];
}

/** Explicit numeric ids the user names directly (customer/partner number). */
function extractNumberCandidates(
  question: string,
): Array<{ value: string; type: QueryEntityType }> {
  const out: Array<{ value: string; type: QueryEntityType }> = [];
  const re =
    /(kundennummer|partnernummer|kunden-nr\.?|partner-nr\.?|nummer)\s*[:#]?\s*(\d{3,12})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(question))) {
    const type: QueryEntityType = /partner/i.test(m[1] ?? "")
      ? "partner_number"
      : "customer_number";
    out.push({ value: m[2]!, type });
  }
  return out;
}

function mapPlanEntityType(type: string): QueryEntityType {
  switch (type) {
    case "customer_name":
    case "vendor":
      return "customer_name";
    case "customer_number":
      return "customer_number";
    case "partner_number":
      return "partner_number";
    case "partner_role":
      return "partner_role";
    case "material":
      return "material";
    case "plant":
      return "plant";
    case "table":
    case "class":
    case "method":
    case "program":
    case "function_module":
    case "field":
      return "identifier";
    default:
      return "unknown";
  }
}

/**
 * Extracts candidate query entities from the raw question (regex, generic —
 * no entity-specific vocabulary) plus, if available, the query planner's
 * already-typed entities (planned_rag mode).
 */
export function extractQueryEntities(
  question: string,
  plan?: QueryPlan | null,
): QueryEntityCandidate[] {
  const out: QueryEntityCandidate[] = [];
  const seen = new Set<string>();
  const push = (value: string, type: QueryEntityType) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = normalizeText(trimmed);
    const key = `${type}|${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ query_entity: trimmed, entity_type: type, normalized_query_entity: normalized });
  };

  const customerCandidate = extractCustomerNameCandidate(question);
  if (customerCandidate) push(customerCandidate, "customer_name");

  for (const id of extractIdentifierCandidates(question)) push(id, "identifier");
  for (const n of extractNumberCandidates(question)) push(n.value, n.type);

  for (const e of plan?.entities ?? []) {
    // Planner "topic"/"process"/"unknown" are search hints, not grounding subjects.
    // Applying them as hard entities caused false not_found → insufficient answers
    // when planned_rag ran (direct_rag has no plan and is unaffected).
    if (
      e.type === "topic" ||
      e.type === "process" ||
      e.type === "unknown" ||
      e.type === "value"
    ) {
      continue;
    }
    const mapped = mapPlanEntityType(e.type);
    if (mapped === "unknown") continue;
    push(e.normalized_value || e.value, mapped);
  }

  return out;
}

// --- Grounding against retrieved hits -----------------------------------

/** German business/technical stopwords excluded from differentiator detection (generic, not entity-specific). */
const DIFFERENTIATOR_STOPWORDS = new Set(
  [
    "kunde",
    "kunden",
    "kundennummer",
    "partner",
    "partnernummer",
    "partnerrolle",
    "tabelle",
    "wert",
    "werte",
    "feld",
    "felder",
    "primarschlussel",
    "primaerschluessel",
    "methode",
    "klasse",
    "system",
    "prozess",
    "regel",
    "bedingung",
    "beleg",
    "auslser",
    "ausloser",
    "material",
    "werk",
    "zeile",
    "spalte",
    "hardcoding",
    "hardcodings",
    "quelle",
    "eintrag",
  ].map(normalizeText),
);

function hitEvidenceRef(hit: KnowledgeHit): string {
  return `#${hit.rank} ${hit.source_key}`;
}

function strongTextNormalized(hit: KnowledgeHit): string {
  const parts = [
    ...(hit.facts ?? []),
    ...(hit.hardcoded_values ?? []),
    ...(hit.entities ?? []).map((e) => e.name),
    ...(hit.evidence ?? []).flatMap((e) => [
      e.text ?? "",
      ...(e.lines ?? []).map((l) => l.quote ?? ""),
    ]),
    ...(hit.evidence_refs ?? []),
    ...(hit.tables_read ?? []),
    ...(hit.tables_written ?? []),
    ...(hit.called_methods ?? []),
    hit.object_name,
    hit.subobject_name,
    hit.source_key,
  ];
  return normalizeText(parts.filter(Boolean).join(" "));
}

function weakTextNormalized(hit: KnowledgeHit): string {
  const parts = [
    hit.title,
    hit.snippet,
    hit.business_purpose,
    hit.technical_summary,
    ...(hit.inferences ?? []),
  ];
  return normalizeText(parts.filter(Boolean).join(" "));
}

/**
 * High-precision, structural extraction: "Kunde/Marke/Partner (ist) X" style
 * phrases in prose source text (facts/business_purpose/evidence) — mirrors
 * the question-side patterns but applied to sources. Generic: works for any
 * name, not a fixed list.
 */
// Note: no `i` flag — the capture group's uppercase-start requirement must
// stay case-sensitive, only the leading keyword itself allows both cases.
const SOURCE_NAMED_SUBJECT_RE =
  /\b(?:[Kk]unde|[Kk]undin|[Mm]arke|[Pp]artner)\s+(?:ist\s+)?([A-ZÄÖÜ][\wÄÖÜäöüß]*(?:[- ][A-ZÄÖÜ][\wÄÖÜäöüß]*){0,3})/g;

function proseRawText(hit: KnowledgeHit): string[] {
  return [
    ...(hit.facts ?? []),
    hit.business_purpose,
    ...(hit.evidence ?? []).flatMap((e) => [
      e.text ?? "",
      ...(e.lines ?? []).map((l) => l.quote ?? ""),
    ]),
  ].filter(Boolean);
}

/**
 * Finds a differently-named concrete subject in the evidence, using only the
 * high-precision "Kunde/Marke/Partner X" structural pattern (generic — no
 * fixed name list). Deliberately conservative: a blanket Title-Case scan
 * over German prose produces too many false positives (any capitalized
 * noun), which would put a wrong/confusing name in front of the user. When
 * this pattern finds nothing, the entity is classified `not_found` instead
 * of `contradicted` — both statuses equally block transferring the rule.
 */
function findDifferentiatorNames(
  hits: KnowledgeHit[],
  excludeNormalized: Set<string>,
): Array<{ name: string; hit: KnowledgeHit }> {
  const out: Array<{ name: string; hit: KnowledgeHit }> = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    for (const text of proseRawText(hit)) {
      for (const m of text.matchAll(SOURCE_NAMED_SUBJECT_RE)) {
        const candidate = m[1]?.trim();
        if (!candidate) continue;
        const norm = normalizeText(candidate);
        if (!norm || norm.length < 3) continue;
        if (DIFFERENTIATOR_STOPWORDS.has(norm)) continue;
        if (excludeNormalized.has(norm)) continue;
        const key = `${norm}|${hit.search_document_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name: candidate, hit });
      }
    }
  }
  return out;
}

function groundNamedSubject(
  entity: QueryEntityCandidate,
  hits: KnowledgeHit[],
): EntityGroundingResult {
  const tokenSet = new Set(
    entity.normalized_query_entity.split(" ").filter((t) => t.length >= 2),
  );

  const strongMatches = hits.filter((h) =>
    containsWholeToken(strongTextNormalized(h), entity.normalized_query_entity),
  );
  if (strongMatches.length > 0) {
    return {
      query_entity: entity.query_entity,
      entity_type: entity.entity_type,
      grounding_status: "confirmed",
      matched_source_entities: [entity.query_entity],
      evidence_refs: strongMatches.map(hitEvidenceRef),
      reason:
        "Entität erscheint wörtlich in belastbaren Quellenfeldern (Facts/Hardcodings/Evidence/Entitäten).",
    };
  }

  const weakMatches = hits.filter((h) =>
    containsWholeToken(weakTextNormalized(h), entity.normalized_query_entity),
  );
  if (weakMatches.length > 0) {
    return {
      query_entity: entity.query_entity,
      entity_type: entity.entity_type,
      grounding_status: "possible",
      matched_source_entities: [entity.query_entity],
      evidence_refs: weakMatches.map(hitEvidenceRef),
      reason:
        "Entität nur in beschreibendem Text (Titel/Snippet/Fließtext), nicht in strukturierten Belegfeldern gefunden.",
    };
  }

  const excludeNormalized = new Set([entity.normalized_query_entity, ...tokenSet]);
  const differentiators = findDifferentiatorNames(hits, excludeNormalized);
  if (differentiators.length > 0) {
    const names = [...new Set(differentiators.map((d) => d.name))].slice(0, 5);
    const refs = [...new Set(differentiators.map((d) => hitEvidenceRef(d.hit)))];
    return {
      query_entity: entity.query_entity,
      entity_type: entity.entity_type,
      grounding_status: "contradicted",
      matched_source_entities: names,
      evidence_refs: refs,
      reason: `Quellen belegen eine andere, konkrete Entität (${names.join(", ")}) — keine Übertragung auf „${entity.query_entity}“ zulässig.`,
    };
  }

  return {
    query_entity: entity.query_entity,
    entity_type: entity.entity_type,
    grounding_status: "not_found",
    matched_source_entities: [],
    evidence_refs: [],
    reason: "Keine Erwähnung dieser Entität und keine abweichende konkrete Entität in den Quellen gefunden.",
  };
}

function groundIdentifier(
  entity: QueryEntityCandidate,
  hits: KnowledgeHit[],
): EntityGroundingResult {
  const strongMatches = hits.filter((h) =>
    containsWholeToken(strongTextNormalized(h), entity.normalized_query_entity),
  );
  if (strongMatches.length > 0) {
    return {
      query_entity: entity.query_entity,
      entity_type: entity.entity_type,
      grounding_status: "confirmed",
      matched_source_entities: [entity.query_entity],
      evidence_refs: strongMatches.map(hitEvidenceRef),
      reason: "Technischer Bezeichner direkt in Quelle (Objekt/Methode/Tabelle/Aufruf) gefunden.",
    };
  }
  const weakMatches = hits.filter((h) =>
    containsWholeToken(weakTextNormalized(h), entity.normalized_query_entity),
  );
  if (weakMatches.length > 0) {
    return {
      query_entity: entity.query_entity,
      entity_type: entity.entity_type,
      grounding_status: "possible",
      matched_source_entities: [entity.query_entity],
      evidence_refs: weakMatches.map(hitEvidenceRef),
      reason: "Technischer Bezeichner nur in beschreibendem Text erwähnt.",
    };
  }
  return {
    query_entity: entity.query_entity,
    entity_type: entity.entity_type,
    grounding_status: "not_found",
    matched_source_entities: [],
    evidence_refs: [],
    reason: "Technischer Bezeichner in keiner Quelle gefunden.",
  };
}

export function groundQueryEntities(params: {
  queryEntities: QueryEntityCandidate[];
  hits: KnowledgeHit[];
}): GroundingReport {
  const results = params.queryEntities.map((entity) =>
    entity.entity_type === "identifier" || entity.entity_type === "unknown"
      ? groundIdentifier(entity, params.hits)
      : groundNamedSubject(entity, params.hits),
  );

  const namedResults = results.filter((r) => NAMED_SUBJECT_TYPES.has(r.entity_type));
  const has_ungrounded_named_entity = namedResults.some(
    (r) => r.grounding_status === "contradicted" || r.grounding_status === "not_found",
  );
  const grounded_entity_names = namedResults
    .filter((r) => r.grounding_status === "confirmed" || r.grounding_status === "possible")
    .map((r) => r.query_entity);
  const contradicted_entity_names = namedResults
    .filter((r) => r.grounding_status === "contradicted" || r.grounding_status === "not_found")
    .map((r) => r.query_entity);

  return {
    query_entities: params.queryEntities,
    results,
    has_ungrounded_named_entity,
    grounded_entity_names,
    contradicted_entity_names,
  };
}

/** Distinct "similar rule, different entity" hints for the answer's optional neighbor-hit note. */
export function similarNeighborEntities(report: GroundingReport): string[] {
  const names = new Set<string>();
  for (const r of report.results) {
    if (r.grounding_status === "contradicted") {
      for (const n of r.matched_source_entities) names.add(n);
    }
  }
  return [...names];
}
