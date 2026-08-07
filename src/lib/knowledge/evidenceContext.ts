/**
 * Structured Evidence Context for answer synthesis.
 * Diversifies coherent source sets; reports truncation — does not change retrieval.
 */

import type { KnowledgeHit } from "@/lib/knowledge/knowledgeRetriever";
import type { AggregatedKnowledgeHit } from "@/lib/knowledge/executeQueryPlan";
import type { EntityGroundingResult } from "@/lib/knowledge/entityGrounding";
import type { QuestionIntentResult } from "@/lib/knowledge/questionIntent";
import { buildControlValueCatalog } from "@/lib/knowledge/richEvidence";
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
  table_row: "table",
  canonical_table_row: "table",
  master_field: "table",
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
  // Rich budget: ~10× früherer Direct-RAG-Evidence (nur nützliche Buckets)
  const codeCap = intent.preferences.prefer_code ? 16 : 14;
  const hasTechAnchor = anchors.some(
    (a) => /^[zy]/i.test(a) || /_/.test(a) || a.length >= 6,
  );
  const tableCap =
    intent.intent === "comparison" && hasTechAnchor
      ? 2
      : intent.preferences.prefer_tables
        ? 12
        : 10;
  const ruleCap = 4;
  const analysisCap = 4;
  const otherCap = 4;

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
  /** Max table_row hits per object/table — Samples, keine Flut. */
  const tableRowPerTable = new Map<string, number>();
  const TABLE_ROW_CAP = 6;

  const hitBlob = (h: KnowledgeHit) =>
    `${h.title} ${h.source_key} ${h.object_name} ${h.subobject_name} ${h.snippet}`.toLowerCase();

  const anchorScore = (h: KnowledgeHit) => {
    if (anchors.length === 0) return 0;
    const b = hitBlob(h);
    return anchors.reduce((n, a) => n + (b.includes(a) ? 1 : 0), 0);
  };

  const ordered = [...hits].sort((a, b) => {
    // Prefer master_field / code_unit with expand markers before raw rows
    const pri = (h: KnowledgeHit) => {
      if (h.knowledge_unit_type === "master_field") return 3;
      if (h.knowledge_unit_type === "code_unit") return 2;
      if (h.knowledge_unit_type === "table_profile") return 1;
      return 0;
    };
    const da = anchorScore(a) * 10 + pri(a);
    const db = anchorScore(b) * 10 + pri(b);
    if (db !== da) return db - da;
    return a.rank - b.rank;
  });

  const tryPick = (h: KnowledgeHit) => {
    if (pickedIds.has(h.search_document_id)) return false;
    if (h.knowledge_unit_type === "table_row") {
      const table = (h.object_name || h.source_key.split("|")[2] || "row").toUpperCase();
      const n = tableRowPerTable.get(table) ?? 0;
      if (n >= TABLE_ROW_CAP) return false;
      tableRowPerTable.set(table, n + 1);
    }
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

  // Cap detailed generously; compact catches overflow of useful ranks
  const detailed = picked.slice(0, 32);
  const detailedIds = new Set(detailed.map((h) => h.search_document_id));
  const compact = hits
    .filter((h) => !detailedIds.has(h.search_document_id))
    .slice(0, 24);
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
    hit.object_type?.toUpperCase() === "TABLE" ||
    hit.knowledge_unit_type === "table_row" ||
    hit.knowledge_unit_type === "table_profile"
      ? hit.object_name
      : hit.knowledge_unit_type === "master_field"
        ? hit.object_name
        : (hit.tables_read?.[0] || hit.tables_written?.[0] || "");

  const callers_callees = [
    ...(hit.called_methods ?? []).slice(0, detail === "full" ? 12 : 4).map((m) => `calls:${m}`),
    ...(hit.called_functions ?? []).slice(0, detail === "full" ? 6 : 2).map((m) => `fn:${m}`),
  ];

  const meta = hit.metadata ?? {};
  const keyValues = meta.key_values;
  const extraFacts: string[] = [];
  if (keyValues && typeof keyValues === "object" && !Array.isArray(keyValues)) {
    for (const [k, v] of Object.entries(keyValues as Record<string, unknown>).slice(0, 8)) {
      extraFacts.push(`${k}=${String(v)}`);
    }
  }
  if (meta.matched_token) {
    extraFacts.push(`Matched token: ${String(meta.matched_token)}`);
  }
  const facts = [...(hit.facts ?? []), ...extraFacts].slice(
    0,
    detail === "full" ? 20 : 6,
  );

  return {
    rank: hit.rank,
    source_id: hit.source_key || hit.search_document_id,
    type: hit.knowledge_unit_type,
    object_type: hit.object_type || "",
    object_name: hit.object_name || "",
    method: hit.subobject_name || "",
    table,
    short_desc:
      (hit.technical_summary || hit.business_purpose || hit.snippet || hit.title || "").slice(
        0,
        detail === "full" ? 900 : 360,
      ),
    facts,
    inferences: (hit.inferences ?? []).slice(0, detail === "full" ? 8 : 2),
    code_data_evidence: evidenceLines(hit, detail === "full" ? 12 : 3),
    relations: relationLines(hit).slice(0, detail === "full" ? 12 : 3),
    callers_callees,
    reads: (hit.tables_read ?? []).slice(0, detail === "full" ? 16 : 6),
    writes: (hit.tables_written ?? []).slice(0, detail === "full" ? 12 : 4),
    confidence: hit.doc_confidence ?? hit.confidence ?? null,
    entity_grounding_status: groundingStatusForHit(hit, grounding),
    hardcoded_values: (hit.hardcoded_values ?? []).slice(
      0,
      detail === "full" ? 24 : 8,
    ),
    detail_level: detail,
  };
}

function extractCommentHints(text: string): string[] {
  const scored: Array<{ text: string; score: number }> = [];
  for (const raw of text.split(/\n|(?=\*)/)) {
    const line = raw.trim();
    if (!line.startsWith("*") && !line.startsWith('"')) continue;
    const cleaned = line.replace(/^[*"]+\s*/, "").trim();
    if (cleaned.length < 24) continue;
    if (!/[a-zA-ZäöüÄÖÜ]{4,}/.test(cleaned)) continue;
    // Skip change-log / email noise
    if (/E-Mail|per Mail|TF\d{3}|Änderung Schlünzen|Thomas Frei/i.test(cleaned)) {
      continue;
    }
    let score = 1;
    if (/virtuell|Lager|Confirm|Absage|Auftrag|Verpack|Prüfung|nicht erlaubt/i.test(cleaned)) {
      score += 5;
    }
    scored.push({ text: cleaned.slice(0, 220), score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.text);
}

/**
 * Deterministic process digest from code evidence (comments + method names).
 * Helps synthesis use available technical process signals without inventing docs.
 */
export function buildCodeProcessDigest(hits: KnowledgeHit[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (h.knowledge_unit_type !== "code_unit") continue;
    const label = [h.object_name, h.subobject_name].filter(Boolean).join(" / ");
    const blob = `${h.technical_summary || ""}\n${h.snippet || ""}`;
    const comments = extractCommentHints(blob);
    const key = `${label}|${comments[0] || blob.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (comments.length > 0) {
      lines.push(`- ${label}: ${comments[0]}`);
    } else if (blob.trim().length > 40) {
      lines.push(`- ${label}: ${blob.replace(/\s+/g, " ").trim().slice(0, 180)}`);
    }
    if (lines.length >= 20) break;
  }
  if (lines.length === 0) return "";
  return [
    "### Prozesssignale aus Code-Kommentaren/Methoden (nur Evidenz, nichts erfinden)",
    "Nutze diese Punkte als Prozessbausteine in der Antwort (Trigger → Prüfung → Wirkung).",
    ...lines,
  ].join("\n");
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

  const processDigest = buildCodeProcessDigest([...detailed, ...compact]);
  const valueCatalog = buildControlValueCatalog(params.hits);

  const prompt_text = [
    "Strukturierter Evidence-Kontext (nur aktuelle Frage, keine Vorfragen):",
    `Intent: ${params.intent.intent} (confidence ${params.intent.confidence.toFixed(2)})`,
    "Anweisung: Baue eine konkrete Prozessantwort aus Feldanker + Steuertabellen + Codewirkungen. " +
      "Die direct_answer muss die Kette nennen: (1) Kennzeichen/Feld, (2) wo es greift (Auftrag/Lieferung), " +
      "(3) konkrete Wirkungen aus Code/Kommentaren, (4) Steuertabellen/Werte. Keine Floskeln. " +
      "Offenes nur markieren, wenn wirklich nicht belegt.",
    params.intent.preferences.require_both_comparison_sides
      ? `Vergleichsseiten im Trefferset: alt=${comparison_sides.has_alt} neu=${comparison_sides.has_neu}`
      : "",
    aggHints.length ? aggHints.join("\n") : "",
    processDigest,
    valueCatalog,
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
        code: params.intent.preferences.prefer_code ? 16 : 14,
        table: params.intent.preferences.prefer_tables ? 12 : 10,
        rule: 4,
        analysis: 4,
        max_detailed: 32,
        max_compact: 24,
      },
      comparison_sides,
      notes,
    },
  };
}
