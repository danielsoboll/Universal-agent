/**
 * Structured Evidence Context for answer synthesis.
 * Diversifies coherent source sets; reports truncation — does not change retrieval.
 */

import type { KnowledgeHit } from "@/lib/knowledge/knowledgeRetriever";
import type { AggregatedKnowledgeHit } from "@/lib/knowledge/executeQueryPlan";
import type { EntityGroundingResult } from "@/lib/knowledge/entityGrounding";
import type { QuestionIntentResult } from "@/lib/knowledge/questionIntent";
import {
  detectComparisonSides,
  questionTopicAnchors,
} from "@/lib/knowledge/questionIntent";

export type StructuredEvidenceSource = {
  rank: number;
  source_id: string;
  type: string;
  object_type: string;
  object_name: string;
  method: string;
  table: string;
  short_desc: string;
  facts: string[];
  inferences: string[];
  code_data_evidence: string[];
  relations: string[];
  callers_callees: string[];
  reads: string[];
  writes: string[];
  confidence: number | null;
  entity_grounding_status: string;
  hardcoded_values: string[];
  detail_level: "full" | "compact";
};

export type EvidenceContextBuildResult = {
  sources: StructuredEvidenceSource[];
  prompt_text: string;
  /** What was truncated / omitted vs raw hits — for diagnostics. */
  truncation_report: {
    input_hit_count: number;
    detailed_count: number;
    compact_count: number;
    omitted_count: number;
    previously_weak_fields_now_included: string[];
    caps: Record<string, number>;
    comparison_sides: { has_alt: boolean; has_neu: boolean };
    notes: string[];
  };
};

const TYPE_BUCKETS: Record<string, "code" | "table" | "rule" | "analysis" | "other"> = {
  code_unit: "code",
  code_unit_analysis: "code",
  control_table: "table",
  control_table_analysis: "table",
  table_profile: "table",
  canonical_table_row: "table",
  business_rule: "rule",
  code_table_interpretation: "analysis",
  dynamic_table_access: "analysis",
};

function bucketOf(hit: KnowledgeHit): "code" | "table" | "rule" | "analysis" | "other" {
  return TYPE_BUCKETS[hit.knowledge_unit_type] ?? "other";
}

function groundingStatusForHit(
  hit: KnowledgeHit,
  grounding: EntityGroundingResult[],
): string {
  const statuses = grounding
    .filter((g) =>
      g.evidence_refs.some(
        (ref) =>
          ref.includes(`#${hit.rank}`) ||
          (hit.source_key && ref.includes(hit.source_key)),
      ),
    )
    .map((g) => g.grounding_status);
  if (statuses.includes("confirmed")) return "confirmed";
  if (statuses.includes("possible")) return "possible";
  if (statuses.includes("contradicted")) return "contradicted";
  if (statuses.includes("not_found")) return "not_found";
  return "n/a";
}

function relationLines(hit: KnowledgeHit): string[] {
  return (hit.relations ?? [])
    .slice(0, 8)
    .map((r) => {
      const from = [r.from_type, r.from_name].filter(Boolean).join(":");
      const to = [r.to_type, r.to_name].filter(Boolean).join(":");
      if (from && to) return `${r.relation_type}: ${from} → ${to}`;
      if (to) return `${r.relation_type}: ${to}`;
      if (from) return `${r.relation_type}: ${from}`;
      return r.relation_type;
    });
}

function evidenceLines(hit: KnowledgeHit, max: number): string[] {
  return (hit.evidence ?? []).slice(0, max).map((e) => {
    const quotes = (e.lines ?? [])
      .slice(0, 2)
      .map((l) => (l.line != null ? `L${l.line}: ${l.quote ?? ""}` : l.quote))
      .filter(Boolean)
      .join(" | ");
    return `[${e.statement_type}] ${e.text ?? ""} ${quotes}`.trim();
  });
}

/**
 * Select a coherent diversified subset for detailed context.
 * Caps prevent blind token growth while covering code+tables+relations.
 */
export function selectCoherentEvidenceHits(
  hits: KnowledgeHit[],
  intent: QuestionIntentResult,
  question?: string,
): { detailed: KnowledgeHit[]; compact: KnowledgeHit[]; omitted: KnowledgeHit[] } {
  if (hits.length === 0) {
    return { detailed: [], compact: [], omitted: [] };
  }

  const anchors = questionTopicAnchors(question ?? "");
  const codeCap = intent.preferences.prefer_code ? 3 : 2;
  // Comparison with technical tokens: don't drown code in generic mapping tables
  const hasTechAnchor = anchors.some(
    (a) => /^[zy]/i.test(a) || /_/.test(a) || a.length >= 6,
  );
  const tableCap =
    intent.intent === "comparison" && hasTechAnchor
      ? 1
      : intent.preferences.prefer_tables
        ? 3
        : 2;
  const ruleCap = 2;
  const analysisCap = 2;
  const otherCap = 1;

  const picked: KnowledgeHit[] = [];
  const pickedIds = new Set<string>();
  const counts = { code: 0, table: 0, rule: 0, analysis: 0, other: 0 };
  const caps = {
    code: codeCap,
    table: tableCap,
    rule: ruleCap,
    analysis: analysisCap,
    other: otherCap,
  };

  const hitBlob = (h: KnowledgeHit) =>
    `${h.title} ${h.source_key} ${h.object_name} ${h.subobject_name} ${h.snippet}`.toLowerCase();

  const anchorScore = (h: KnowledgeHit) => {
    if (anchors.length === 0) return 0;
    const b = hitBlob(h);
    return anchors.reduce((n, a) => n + (b.includes(a) ? 1 : 0), 0);
  };

  const ordered = [...hits].sort((a, b) => {
    const da = anchorScore(a);
    const db = anchorScore(b);
    if (db !== da) return db - da;
    return a.rank - b.rank;
  });

  const tryPick = (h: KnowledgeHit) => {
    if (pickedIds.has(h.search_document_id)) return false;
    const b = bucketOf(h);
    if (counts[b] >= caps[b]) return false;
    picked.push(h);
    pickedIds.add(h.search_document_id);
    counts[b] += 1;
    return true;
  };

  // Comparison: lock in one alt-side + one neu-side code unit first
  if (intent.preferences.require_both_comparison_sides) {
    let gotAlt = false;
    let gotNeu = false;
    for (const h of ordered) {
      if (bucketOf(h) !== "code" && bucketOf(h) !== "table") continue;
      const s = detectComparisonSides([hitBlob(h)]);
      if (!gotAlt && s.has_alt) {
        tryPick(h);
        gotAlt = true;
      } else if (!gotNeu && s.has_neu) {
        tryPick(h);
        gotNeu = true;
      }
      if (gotAlt && gotNeu) break;
    }
  }

  // Prefer topic-anchored hits, then fill by rank/bucket
  for (const h of ordered) {
    if (anchorScore(h) > 0) tryPick(h);
  }
  for (const h of hits) tryPick(h);

  // Comparison: ensure alt and neu sides if present in hit set
  if (intent.preferences.require_both_comparison_sides) {
    const sidesInHits = detectComparisonSides(
      hits.map(
        (h) =>
          `${h.title} ${h.source_key} ${h.snippet} ${h.object_name} ${h.subobject_name}`,
      ),
    );
    let needAlt =
      sidesInHits.has_alt &&
      !detectComparisonSides(
        picked.map(
          (h) => `${h.title} ${h.source_key} ${h.object_name} ${h.subobject_name}`,
        ),
      ).has_alt;
    let needNeu =
      sidesInHits.has_neu &&
      !detectComparisonSides(
        picked.map(
          (h) => `${h.title} ${h.source_key} ${h.object_name} ${h.subobject_name}`,
        ),
      ).has_neu;
    for (const h of hits) {
      if (!needAlt && !needNeu) break;
      if (pickedIds.has(h.search_document_id)) continue;
      const s = detectComparisonSides([
        `${h.title} ${h.source_key} ${h.object_name} ${h.subobject_name}`,
      ]);
      if ((needAlt && s.has_alt) || (needNeu && s.has_neu)) {
        picked.push(h);
        pickedIds.add(h.search_document_id);
        if (s.has_alt) needAlt = false;
        if (s.has_neu) needNeu = false;
      }
    }
  }

  // Cap detailed at 10; remainder of selected → compact; rest omitted
  const detailed = picked.slice(0, 10);
  const detailedIds = new Set(detailed.map((h) => h.search_document_id));
  const compact = hits
    .filter((h) => !detailedIds.has(h.search_document_id))
    .slice(0, 6);
  const compactIds = new Set(compact.map((h) => h.search_document_id));
  const omitted = hits.filter(
    (h) =>
      !detailedIds.has(h.search_document_id) &&
      !compactIds.has(h.search_document_id),
  );

  return { detailed, compact, omitted };
}

function toStructured(
  hit: KnowledgeHit,
  grounding: EntityGroundingResult[],
  detail: "full" | "compact",
): StructuredEvidenceSource {
  const table =
    hit.object_type?.toUpperCase() === "TABLE"
      ? hit.object_name
      : (hit.tables_read?.[0] || hit.tables_written?.[0] || "");

  const callers_callees = [
    ...(hit.called_methods ?? []).slice(0, detail === "full" ? 12 : 4).map((m) => `calls:${m}`),
    ...(hit.called_functions ?? []).slice(0, detail === "full" ? 6 : 2).map((m) => `fn:${m}`),
  ];

  return {
    rank: hit.rank,
    source_id: hit.source_key || hit.search_document_id,
    type: hit.knowledge_unit_type,
    object_type: hit.object_type || "",
    object_name: hit.object_name || "",
    method: hit.subobject_name || "",
    table,
    short_desc:
      (hit.technical_summary || hit.snippet || hit.title || "").slice(0, 320),
    facts: (hit.facts ?? []).slice(0, detail === "full" ? 8 : 3),
    inferences: (hit.inferences ?? []).slice(0, detail === "full" ? 4 : 1),
    code_data_evidence: evidenceLines(hit, detail === "full" ? 6 : 2),
    relations: relationLines(hit).slice(0, detail === "full" ? 8 : 2),
    callers_callees,
    reads: (hit.tables_read ?? []).slice(0, detail === "full" ? 10 : 4),
    writes: (hit.tables_written ?? []).slice(0, detail === "full" ? 8 : 3),
    confidence: hit.doc_confidence ?? hit.confidence ?? null,
    entity_grounding_status: groundingStatusForHit(hit, grounding),
    hardcoded_values: (hit.hardcoded_values ?? []).slice(
      0,
      detail === "full" ? 16 : 6,
    ),
    detail_level: detail,
  };
}

function formatSourceBlock(s: StructuredEvidenceSource): string {
  if (s.detail_level === "compact") {
    return [
      `### Quelle #${s.rank} [compact] | ${s.object_name || s.source_id}`,
      `source_id: ${s.source_id}`,
      `type: ${s.type}`,
      s.method ? `method: ${s.method}` : "",
      `short_desc: ${s.short_desc}`,
      s.facts.length ? `facts: ${s.facts.join(" | ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `### Quelle #${s.rank} | ${s.object_name || s.source_id}`,
    `source_id: ${s.source_id}`,
    `type: ${s.type}`,
    `object_type: ${s.object_type}`,
    `object_name: ${s.object_name}`,
    s.method ? `method: ${s.method}` : "",
    s.table ? `table: ${s.table}` : "",
    `short_desc: ${s.short_desc}`,
    `confidence: ${s.confidence ?? "—"}`,
    `entity_grounding_status: ${s.entity_grounding_status}`,
    s.facts.length ? `facts:\n${s.facts.map((f) => `- FACT: ${f}`).join("\n")}` : "",
    s.inferences.length
      ? `inferences:\n${s.inferences.map((i) => `- INFERENCE: ${i}`).join("\n")}`
      : "",
    s.code_data_evidence.length
      ? `code_data_evidence:\n${s.code_data_evidence.map((e) => `- ${e}`).join("\n")}`
      : "",
    s.relations.length
      ? `relations:\n${s.relations.map((r) => `- ${r}`).join("\n")}`
      : "",
    s.callers_callees.length
      ? `callers_callees: ${s.callers_callees.join(", ")}`
      : "",
    s.reads.length ? `reads: ${s.reads.join(", ")}` : "",
    s.writes.length ? `writes: ${s.writes.join(", ")}` : "",
    s.hardcoded_values.length
      ? `hardcoded_values: ${s.hardcoded_values.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build structured evidence context for the synthesizer.
 * Prefer this over dumping raw hits; keeps Direct RAG ranking untouched.
 *
 * `coverage: "exhaustive"` is used only by full_analysis — raises caps without
 * changing normal Direct/Planned RAG defaults.
 */
export function buildEvidenceContext(params: {
  hits: KnowledgeHit[];
  intent: QuestionIntentResult;
  groundingResults?: EntityGroundingResult[];
  question?: string;
  coverage?: "normal" | "exhaustive";
}): EvidenceContextBuildResult {
  const grounding = params.groundingResults ?? [];
  const coverage = params.coverage ?? "normal";

  let detailed: KnowledgeHit[];
  let compact: KnowledgeHit[];
  let omitted: KnowledgeHit[];

  if (coverage === "exhaustive") {
    // Broader context for Vollanalyse — still capped for token safety.
    detailed = params.hits.slice(0, 24);
    const detailedIds = new Set(detailed.map((h) => h.search_document_id));
    compact = params.hits
      .filter((h) => !detailedIds.has(h.search_document_id))
      .slice(0, 16);
    const compactIds = new Set(compact.map((h) => h.search_document_id));
    omitted = params.hits.filter(
      (h) =>
        !detailedIds.has(h.search_document_id) &&
        !compactIds.has(h.search_document_id),
    );
  } else {
    const selected = selectCoherentEvidenceHits(
      params.hits,
      params.intent,
      params.question,
    );
    detailed = selected.detailed;
    compact = selected.compact;
    omitted = selected.omitted;
  }

  const sources = [
    ...detailed.map((h) => toStructured(h, grounding, "full")),
    ...compact.map((h) => toStructured(h, grounding, "compact")),
  ];

  const comparison_sides = detectComparisonSides(
    params.hits.map(
      (h) => `${h.title} ${h.source_key} ${h.object_name} ${h.subobject_name}`,
    ),
  );

  const notes: string[] = [];
  if (omitted.length > 0) {
    notes.push(
      `${omitted.length} weitere Treffer nur als Rank-Liste weggelassen (Token-Budget).`,
    );
  }
  if (
    params.intent.preferences.require_both_comparison_sides &&
    !(comparison_sides.has_alt && comparison_sides.has_neu)
  ) {
    notes.push(
      "Vergleichsfrage: im Index/Trefferset nicht beide Seiten (alt/neu) belegt — ehrlich offen lassen.",
    );
  }

  // Previous formatSourcesForPrompt omitted relations / structured fields.
  const previously_weak_fields_now_included = [
    "relations",
    "callers_callees",
    "reads/writes",
    "entity_grounding_status",
    "typed facts/inferences",
    "diversified code+table+rule set",
  ];

  const aggHints = detailed
    .map((h) => {
      const a = h as AggregatedKnowledgeHit;
      return a.matched_subqueries?.length
        ? `#${h.rank} subqueries: ${a.matched_subqueries.join(", ")}`
        : "";
    })
    .filter(Boolean);

  const prompt_text = [
    "Strukturierter Evidence-Kontext (nur aktuelle Frage, keine Vorfragen):",
    `Intent: ${params.intent.intent} (confidence ${params.intent.confidence.toFixed(2)})`,
    params.intent.preferences.require_both_comparison_sides
      ? `Vergleichsseiten im Trefferset: alt=${comparison_sides.has_alt} neu=${comparison_sides.has_neu}`
      : "",
    aggHints.length ? aggHints.join("\n") : "",
    "",
    ...sources.map(formatSourceBlock),
    omitted.length
      ? `\nWeitere Ränge ohne Detail: ${omitted.map((h) => `#${h.rank}`).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    sources,
    prompt_text,
    truncation_report: {
      input_hit_count: params.hits.length,
      detailed_count: detailed.length,
      compact_count: compact.length,
      omitted_count: omitted.length,
      previously_weak_fields_now_included,
      caps: {
        code: params.intent.preferences.prefer_code ? 3 : 2,
        table: params.intent.preferences.prefer_tables ? 3 : 2,
        rule: 2,
        analysis: 2,
        max_detailed: 10,
        max_compact: 6,
      },
      comparison_sides,
      notes,
    },
  };
}
