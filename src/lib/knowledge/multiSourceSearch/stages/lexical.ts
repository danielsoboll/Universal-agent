/**
 * Stage: generische lexikalische DDIC-/Objektsuche vor Semantik und Expansion.
 * Keine kundenspezifischen Sonderregeln.
 */
import { AnchorSet, makeAnchor } from "@/lib/knowledge/multiSourceSearch/anchors";
import type {
  MultiSourceSearchPlan,
  PrimaryAnchor,
  SourceCoverage,
  SpecializedSearchPlan,
  StageEvidenceItem,
  StageResult,
} from "@/lib/knowledge/multiSourceSearch/types";
import {
  buildLexicalCorpus,
  lexicalHitToPrimaryField,
  runLexicalSearch,
  type LexicalSearchDiagnosis,
} from "@/lib/search/lexical";

export async function runLexicalStage(params: {
  projectKey: string;
  plan: MultiSourceSearchPlan;
  anchors: AnchorSet;
  coverage: SourceCoverage;
  round: number;
  specialized?: SpecializedSearchPlan;
}): Promise<
  StageResult & {
    primary_anchor_detected?: PrimaryAnchor | null;
    lexical_diagnosis?: LexicalSearchDiagnosis;
  }
> {
  const started = Date.now();
  const corpus = buildLexicalCorpus(params.projectKey);
  const result = runLexicalSearch({
    question: params.plan.question,
    documents: corpus,
    limit: 40,
  });

  const hits: StageEvidenceItem[] = result.hits.slice(0, 24).map((h, i) => ({
    id: `lexical:${h.doc.id}`,
    source: "lexical" as const,
    rank_tier:
      h.channels.includes("exact_phrase") || h.channels.includes("exact_technical")
        ? ("exact" as const)
        : h.channels.includes("all_terms")
          ? ("value_check" as const)
          : ("semantic_weak" as const),
    evidence_type:
      h.doc.kind === "ddic_field"
        ? "MASTER_DATA_BUSINESS_FIELD"
        : h.doc.kind === "control_table" || h.doc.kind === "message_config"
          ? "CONFIGURATION_OBJECT"
          : undefined,
    title: h.doc.technical_name,
    summary: [
      h.doc.field_text || h.doc.table_text || h.doc.code_summary || h.doc.title,
      `score=${h.score}`,
      `channels=${h.channels.join(",")}`,
    ]
      .filter(Boolean)
      .join(" · "),
    object_name: h.doc.technical_name,
    object_type: h.doc.kind,
    table_name: h.doc.table_name,
    field_name: h.doc.field_name,
    anchors_matched: [...h.matched_phrases, ...h.matched_terms].slice(0, 8),
    confidence: Math.min(0.99, 0.4 + h.score / 250),
    path_hint: h.doc.source_path,
    raw_excerpt: JSON.stringify({
      boosts: h.boosts,
      channels: h.channels,
      primary_anchor_candidate: h.primary_anchor_candidate,
    }),
  }));

  const newAnchors = [];
  let primary: PrimaryAnchor | null = null;
  for (const h of result.hits) {
    const field = lexicalHitToPrimaryField(h);
    if (!field) continue;
    if (!primary) {
      primary = {
        anchor_type: "MASTER_DATA_BUSINESS_FIELD",
        table: field.table,
        field: field.field,
        description: field.description,
        business_concept: h.matched_phrases[0] ?? h.matched_terms.join(" "),
        match_type: h.channels.includes("exact_phrase")
          ? "lexical_exact_phrase"
          : h.channels.includes("all_terms")
            ? "lexical_all_terms"
            : "lexical",
        confidence: Math.min(0.98, 0.55 + field.score / 200),
      };
    }
    const fieldAnchor = makeAnchor({
      kind: "field",
      value: field.field,
      source: "lexical",
      confidence: 0.92,
      note: `Lexikalisch: ${field.table}-${field.field}`,
    });
    const tableAnchor = makeAnchor({
      kind: "table",
      value: field.table,
      source: "lexical",
      confidence: 0.7,
    });
    if (fieldAnchor) newAnchors.push(fieldAnchor);
    if (tableAnchor) newAnchors.push(tableAnchor);
    break;
  }

  // Control-table primary if strongest lexical hit is a Z/Y control table with phrase
  if (!primary) {
    const ct = result.hits.find(
      (h) =>
        h.primary_anchor_candidate &&
        h.doc.kind === "control_table" &&
        /^[ZY]/i.test(h.doc.technical_name),
    );
    if (ct) {
      primary = {
        anchor_type: "CONTROL_TABLE",
        table: ct.doc.technical_name,
        description: ct.doc.table_text ?? ct.doc.field_text,
        match_type: "lexical_control_table",
        confidence: Math.min(0.95, 0.5 + ct.score / 200),
      };
      const a = makeAnchor({
        kind: "table",
        value: ct.doc.technical_name,
        source: "lexical",
        confidence: 0.9,
        note: "Lexikalische Steuertabelle",
      });
      if (a) newAnchors.push(a);
    }
  }

  return {
    stage: "lexical",
    round: params.round,
    inputs: {
      anchors: params.anchors.allNeedles(),
      concepts: result.normalized.content_terms,
      synonyms: result.normalized.phrases,
    },
    queries: [
      {
        query: result.normalized.phrases.slice(0, 5).join(" | "),
        purpose: "exact phrase / all-term lexical DDIC",
        hit_count: hits.length,
      },
    ],
    hits,
    new_anchors: newAnchors,
    confidence: primary ? primary.confidence : hits[0]?.confidence ?? 0,
    why_next: primary
      ? "Lexikalischer Primäranker gesetzt — Relationsexpansion gezielt."
      : "Keine starken lexikalischen Primäranker — weiter mit Exact/Master-Data.",
    abort: false,
    coverage: {
      ...params.coverage,
      record_count_estimate: corpus.length,
      diagnosis: `Lexikalisches Korpus: ${corpus.length} Dokumente`,
    },
    duration_ms: Date.now() - started,
    primary_anchor_detected: primary,
    lexical_diagnosis: result.diagnosis,
  };
}
