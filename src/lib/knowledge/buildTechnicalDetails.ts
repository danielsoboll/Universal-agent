import type { KnowledgeHit } from "@/lib/knowledge/types";
import type {
  CompactTechnicalDetails,
  TechnicalDetails,
} from "@/lib/knowledge/answerSchema";
import { EMPTY_TECHNICAL_DETAILS } from "@/lib/knowledge/answerSchema";
import type { EntityGroundingResult } from "@/lib/knowledge/entityGrounding";

function uniq(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function methodKey(name: string): string {
  return name.trim().toUpperCase();
}

/** Include caller/callee neighbors from the retrieval set (1-hop via called_methods). */
export function expandRelatedHits(
  primary: KnowledgeHit[],
  allHits: KnowledgeHit[],
): KnowledgeHit[] {
  if (primary.length === 0) return allHits.slice(0, 5);
  const out: KnowledgeHit[] = [...primary];
  const ids = new Set(primary.map((h) => h.search_document_id));
  const primaryMethods = new Set(
    primary
      .map((h) => h.subobject_name)
      .filter(Boolean)
      .map(methodKey),
  );

  for (const h of allHits) {
    if (ids.has(h.search_document_id)) continue;
    const callsPrimary = (h.called_methods ?? []).some((c) =>
      primaryMethods.has(methodKey(c)),
    );
    const calledByPrimary =
      Boolean(h.subobject_name) &&
      primary.some((p) =>
        (p.called_methods ?? []).some(
          (c) => methodKey(c) === methodKey(h.subobject_name),
        ),
      );
    if (callsPrimary || calledByPrimary) {
      out.push(h);
      ids.add(h.search_document_id);
    }
  }
  return out;
}

/**
 * Deterministic technical detail extraction from retrieval hits.
 * Does not invent facts — only copies fields already on SearchDocuments.
 */
export function buildTechnicalDetailsFromHits(
  hits: KnowledgeHit[],
  retrievalMode: string,
): TechnicalDetails {
  if (hits.length === 0) {
    return { ...EMPTY_TECHNICAL_DETAILS, retrieval_mode: retrievalMode };
  }

  const sources = hits.map((h) => ({
    object_kind: h.object_type || h.knowledge_unit_type || "",
    class_or_program: h.object_name || "",
    method_or_routine: h.subobject_name || "",
    source_key: h.source_key,
    title: h.title,
    knowledge_unit_type: h.knowledge_unit_type,
    rank: h.rank,
    score: h.combined_score,
  }));

  const methodNames = new Set(
    hits
      .map((h) => h.subobject_name)
      .filter(Boolean)
      .map(methodKey),
  );

  const callers: string[] = [];
  for (const h of hits) {
    for (const called of h.called_methods ?? []) {
      const key = methodKey(called);
      if (methodNames.has(key) && h.subobject_name) {
        const target = hits.find((x) => methodKey(x.subobject_name) === key);
        if (target?.subobject_name) {
          callers.push(
            `${h.subobject_name} → ${target.subobject_name}`,
          );
        }
      }
    }
  }
  // Also: if hit A lists SET_X and hit B is SET_X, already covered.
  // Reverse: methods in hits that are called by other hits.
  for (const target of hits) {
    if (!target.subobject_name) continue;
    const tKey = methodKey(target.subobject_name);
    for (const h of hits) {
      if (h.search_document_id === target.search_document_id) continue;
      if ((h.called_methods ?? []).some((c) => methodKey(c) === tKey)) {
        callers.push(`${h.subobject_name || h.title} → ${target.subobject_name}`);
      }
    }
  }

  const called_objects = uniq(hits.flatMap((h) => h.called_methods ?? []));
  const hardcoded_values = uniq(hits.flatMap((h) => h.hardcoded_values ?? []));
  const facts = uniq(hits.flatMap((h) => h.facts ?? []));
  const inferences = uniq(hits.flatMap((h) => h.inferences ?? []));

  const table_accesses = uniq(
    hits.flatMap((h) => [
      ...(h.tables_read ?? []).map((t) => `READ ${t}`),
      ...(h.tables_written ?? []).map((t) => `WRITE ${t}`),
    ]),
  );

  const evidence = uniq(
    hits.flatMap((h) => {
      const fromStructured = (h.evidence ?? []).flatMap((e) => {
        const lines = (e.lines ?? [])
          .map((l) =>
            l.line != null && l.quote
              ? `Z.${l.line}: ${l.quote}`
              : l.quote || "",
          )
          .filter(Boolean);
        if (e.text && lines.length) return [`${e.text} — ${lines.join(" | ")}`];
        if (e.text) return [e.text];
        return lines;
      });
      return [...fromStructured, ...(h.evidence_refs ?? [])];
    }),
  );

  const confidences = hits
    .map((h) => h.doc_confidence ?? h.confidence)
    .filter((c): c is number => typeof c === "number");
  const confidence =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null;

  return {
    sources,
    callers: uniq(callers),
    called_objects,
    conditions: [],
    table_accesses,
    hardcoded_values,
    changed_fields: [],
    evidence: evidence.slice(0, 40),
    facts: facts.slice(0, 40),
    inferences: inferences.slice(0, 40),
    confidence,
    retrieval_mode: retrievalMode,
    retrieval_scores: hits.map((h) => ({
      rank: h.rank,
      title: h.title,
      combined: h.combined_score,
      exact: h.exact_score,
      fulltext: h.fulltext_score,
      vector: h.vector_score,
    })),
  };
}

type HardcodingClassification = {
  label: string;
  section: "ausloeser" | "systemaktion" | "hidden";
};

/**
 * Semantic label for a "KEY=VALUE" (or bare) hardcoding, derived purely from
 * the field-name pattern — never from the literal value — so it stays
 * generic across customers/materials/plants instead of matching specific
 * test-case names.
 */
function classifyHardcoding(raw: string): HardcodingClassification {
  const eq = raw.indexOf("=");
  const key = eq > 0 ? raw.slice(0, eq).trim() : "";
  const keyNorm = key.toLowerCase();

  if (/kunnr|kundennummer|customer.?number|customer.?id/.test(keyNorm)) {
    return { label: "Relevante Kundennummer", section: "ausloeser" };
  }
  if (/parvw|partnerrolle|partner.?role/.test(keyNorm)) {
    return { label: "Partnerrolle", section: "ausloeser" };
  }
  if (/lifnr|vendor|lieferant/.test(keyNorm)) {
    return { label: "Relevante Lieferantennummer", section: "ausloeser" };
  }
  if (/matnr|material/.test(keyNorm)) {
    return { label: "Relevantes Material", section: "ausloeser" };
  }
  if (/werk|plant/.test(keyNorm)) {
    return { label: "Relevantes Werk", section: "ausloeser" };
  }
  if (/vkorg|sales.?org/.test(keyNorm)) {
    return { label: "Relevante Verkaufsorganisation", section: "ausloeser" };
  }
  if (key) {
    return { label: `Gesetzter Wert: ${key}`, section: "systemaktion" };
  }
  return { label: "Nicht eindeutig zugeordnet", section: "hidden" };
}

function shortEvidenceLine(hit: KnowledgeHit): string[] {
  const lines: string[] = [];
  for (const e of hit.evidence ?? []) {
    const quotes = (e.lines ?? [])
      .slice(0, 1)
      .map((l) => (l.line != null && l.quote ? `Z.${l.line}: ${l.quote}` : l.quote))
      .filter(Boolean);
    if (e.text) {
      lines.push(`#${hit.rank} ${e.text}${quotes.length ? ` — ${quotes.join(" | ")}` : ""}`);
    } else if (quotes.length) {
      lines.push(`#${hit.rank} ${quotes.join(" | ")}`);
    }
    if (lines.length >= 2) break;
  }
  if (lines.length === 0 && hit.facts?.[0]) {
    lines.push(`#${hit.rank} ${hit.facts[0]}`);
  }
  return lines;
}

/**
 * Compact technical details (max 5 sections: Quelle, Auslöser, Systemaktion,
 * Beleg, Unsicherheit). Only covers `hits` actually backing the answer
 * (grounding-confirmed/possible sources) — never a dump of everything
 * retrieved. Hardcodings are semantically labeled; unclear-role ones are
 * routed to `hidden_hardcodings` (shown only in the full/raw analysis view).
 */
export function buildCompactTechnicalDetails(params: {
  hits: KnowledgeHit[];
  groundingResults: EntityGroundingResult[];
  extraUncertainties?: string[];
  /** LLM-narrated conditions ("Auslöser"), restricted to what sources support. */
  extraAusloeser?: string[];
  /** LLM-narrated field changes ("Systemaktion"), restricted to what sources support. */
  extraSystemaktion?: string[];
}): CompactTechnicalDetails {
  const {
    hits,
    groundingResults,
    extraUncertainties = [],
    extraAusloeser = [],
    extraSystemaktion = [],
  } = params;

  const quelle = uniq(
    hits.map((h) => {
      const kind = h.object_type || h.knowledge_unit_type || "Objekt";
      const parts = [kind];
      if (h.object_name) parts.push(h.object_name);
      if (h.subobject_name) parts.push(`/ ${h.subobject_name}`);
      const callers = (h.called_methods ?? []).slice(0, 3);
      const label = `${parts.join(" ")} (${h.source_key})`;
      return callers.length
        ? `${label} — ruft auf: ${callers.join(", ")}`
        : label;
    }),
  ).slice(0, 8);

  const ausloeser = new Set<string>();
  const systemaktion = new Set<string>();
  const hidden_hardcodings = new Set<string>();

  for (const h of hits) {
    for (const t of h.tables_read ?? []) ausloeser.add(`Tabelle (gelesen): ${t}`);
    for (const t of h.tables_written ?? []) systemaktion.add(`Tabelle (geschrieben): ${t}`);
    for (const raw of h.hardcoded_values ?? []) {
      const { label, section } = classifyHardcoding(raw);
      const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1).trim() : raw;
      if (section === "hidden") {
        hidden_hardcodings.add(raw);
      } else if (section === "ausloeser") {
        ausloeser.add(`${label}: ${value}`);
      } else {
        systemaktion.add(`${label} = ${value}`);
      }
    }
  }

  for (const a of extraAusloeser) if (a.trim()) ausloeser.add(a.trim());
  for (const s of extraSystemaktion) if (s.trim()) systemaktion.add(s.trim());

  const beleg = uniq(hits.flatMap(shortEvidenceLine)).slice(0, 5);

  const unsicherheit = uniq([
    ...groundingResults
      .filter((r) => r.grounding_status !== "confirmed")
      .map((r) => `„${r.query_entity}“ (${r.entity_type}): ${r.reason}`),
    ...extraUncertainties,
  ]);

  return {
    quelle,
    ausloeser: [...ausloeser].slice(0, 8),
    systemaktion: [...systemaktion].slice(0, 8),
    beleg,
    unsicherheit,
    hidden_hardcodings: [...hidden_hardcodings],
  };
}

export function mergeTechnicalDetails(
  fromHits: TechnicalDetails,
  fromLlm: {
    conditions?: string[];
    changed_fields?: string[];
    additional_evidence_notes?: string[];
  },
): TechnicalDetails {
  return {
    ...fromHits,
    conditions: uniq([...(fromLlm.conditions ?? [])]),
    changed_fields: uniq([...(fromLlm.changed_fields ?? [])]),
    evidence: uniq([
      ...fromHits.evidence,
      ...(fromLlm.additional_evidence_notes ?? []),
    ]).slice(0, 50),
  };
}
