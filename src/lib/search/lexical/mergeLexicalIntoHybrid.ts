/**
 * Map strong lexical hits onto hybrid SearchDocuments and promote them.
 * Same ranking signals as multi-source lexical stage — used by Direct Search.
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import type { LexicalHit } from "@/lib/search/lexical/types";
import { lexicalHitToPrimaryField } from "@/lib/search/lexical/runLexicalSearch";

/** Floor so phrase/DDIC lexical hits outrank single-term IDF noise (e.g. org names). */
const LEXICAL_SCORE_FLOOR = 80;

function evidenceRefsFromDoc(doc: SearchDocument): string[] {
  const meta = doc.metadata?.evidence_refs;
  if (Array.isArray(meta)) return meta.map(String).slice(0, 30);
  return [];
}

function matchDocuments(
  hit: LexicalHit,
  documents: SearchDocument[],
): SearchDocument[] {
  const tech = hit.doc.technical_name.toUpperCase();
  const table = (hit.doc.table_name ?? "").toUpperCase();
  const field = (hit.doc.field_name ?? "").toUpperCase();
  const out: SearchDocument[] = [];

  for (const d of documents) {
    const title = (d.title ?? "").toUpperCase();
    const key = (d.source_key ?? "").toUpperCase();
    const obj = (d.object_name ?? "").toUpperCase();
    const metaTable = String(d.metadata?.table_name ?? "").toUpperCase();
    const metaField = String(d.metadata?.field_name ?? "").toUpperCase();
    const kut = d.knowledge_unit_type;

    if (hit.doc.kind === "ddic_field") {
      if (kut !== "master_field") continue;
      if (
        title === tech ||
        (table &&
          field &&
          metaTable === table &&
          metaField === field) ||
        (table && field && key.includes(`|${table}|${field}`))
      ) {
        out.push(d);
      }
      continue;
    }

    if (
      hit.doc.kind === "control_table" ||
      hit.doc.kind === "table_profile" ||
      hit.doc.kind === "ddic_table"
    ) {
      if (
        kut === "table_profile" ||
        kut === "control_table" ||
        kut === "ddic_table"
      ) {
        if (
          key === `TABLE_PROFILE:${tech}` ||
          obj === tech ||
          title.includes(tech)
        ) {
          out.push(d);
        }
      }
      continue;
    }

    if (
      hit.doc.kind === "method" ||
      hit.doc.kind === "program" ||
      hit.doc.kind === "function_module" ||
      hit.doc.kind === "form_routine"
    ) {
      if (
        key.includes(tech) ||
        title.includes(tech) ||
        obj === tech ||
        (d.subobject_name ?? "").toUpperCase() === tech
      ) {
        out.push(d);
      }
    }
  }
  return out;
}

function hitFromDoc(
  doc: SearchDocument,
  lexical: LexicalHit,
  rank: number,
): KnowledgeHit {
  const channels = lexical.channels.join(",");
  return {
    rank,
    search_document_id: doc.search_document_id,
    source_key: doc.source_key,
    title: doc.title,
    knowledge_unit_type: doc.knowledge_unit_type,
    combined_score: LEXICAL_SCORE_FLOOR + lexical.score,
    exact_score: lexical.channels.includes("exact_phrase") ? 4 : 1,
    fulltext_score: lexical.score / 10,
    vector_score: 0,
    metadata_score: 1,
    confidence_bonus: (doc.confidence ?? 0.5) * 0.5,
    confidence: doc.confidence ?? null,
    matched_terms: [
      ...lexical.matched_phrases.map((p) => `phrase:${p}`),
      ...lexical.matched_terms.slice(0, 8),
      `lexical:${channels}`,
    ],
    snippet: [
      lexical.doc.field_text || lexical.doc.table_text || doc.business_purpose,
      doc.search_text?.slice(0, 180),
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 280),
    evidence_refs: evidenceRefsFromDoc(doc),
    facts: doc.facts ?? [],
    inferences: doc.inferences ?? [],
    metadata: {
      ...((doc.metadata as Record<string, unknown>) ?? {}),
      lexical_score: lexical.score,
      lexical_channels: lexical.channels,
      lexical_primary_anchor: lexical.primary_anchor_candidate,
    },
    object_name: doc.object_name ?? "",
    object_type: doc.object_type ?? "",
    subobject_name: doc.subobject_name ?? "",
    technical_summary: doc.technical_summary ?? "",
    business_purpose: doc.business_purpose ?? "",
    tables_read: doc.tables_read ?? [],
    tables_written: doc.tables_written ?? [],
    called_methods: doc.called_methods ?? [],
    called_functions: doc.called_functions ?? [],
    hardcoded_values: doc.hardcoded_values ?? [],
    entities: doc.entities ?? [],
    relations: doc.relations ?? [],
    evidence: doc.evidence ?? [],
    doc_confidence: doc.confidence ?? null,
  };
}

export type LexicalMergeResult = {
  hits: KnowledgeHit[];
  promoted: number;
  primary_fields: Array<{
    table: string;
    field: string;
    description: string;
    score: number;
  }>;
  /** Technical tokens derived from lexical primary anchors (for expansion). */
  expansion_tokens: string[];
};

/**
 * Prepend strong lexical matches; expand related docs by primary-anchor tokens;
 * keep remaining hybrid hits for diversity.
 */
export function mergeLexicalIntoHybridHits(params: {
  hybridHits: KnowledgeHit[];
  lexicalHits: LexicalHit[];
  documents: SearchDocument[];
  limit: number;
}): LexicalMergeResult {
  const strong = params.lexicalHits.filter(
    (h) =>
      h.score >= 90 &&
      (h.channels.includes("exact_phrase") ||
        h.channels.includes("exact_technical") ||
        h.channels.includes("all_terms") ||
        h.primary_anchor_candidate),
  );

  const promoted: KnowledgeHit[] = [];
  const seen = new Set<string>();

  for (const lh of strong) {
    for (const doc of matchDocuments(lh, params.documents)) {
      if (seen.has(doc.search_document_id)) continue;
      seen.add(doc.search_document_id);
      promoted.push(hitFromDoc(doc, lh, promoted.length + 1));
    }
  }

  const primary_fields: LexicalMergeResult["primary_fields"] = [];
  const expansion_tokens = new Set<string>();
  for (const lh of strong) {
    const field = lexicalHitToPrimaryField(lh);
    if (field) {
      primary_fields.push(field);
      // Prefer field + compound; skip bare short standard tables as search needles
      expansion_tokens.add(field.field.toUpperCase());
      expansion_tokens.add(`${field.table}-${field.field}`.toUpperCase());
      if (field.table.length >= 6 || /^[ZY]/.test(field.table)) {
        expansion_tokens.add(field.table.toUpperCase());
      }
    } else if (lh.primary_anchor_candidate) {
      expansion_tokens.add(lh.doc.technical_name.toUpperCase());
    }
  }

  // Generic expansion: code / rows / profiles that mention primary field tokens
  const expanded: KnowledgeHit[] = [];
  const needles = [...expansion_tokens].filter((t) => t.length >= 4);
  if (needles.length > 0) {
    const expandTypes = new Set([
      "code_unit",
      "table_row",
      "table_profile",
      "control_table",
      "master_field",
      "business_rule",
    ]);
    const scored: Array<{ doc: SearchDocument; score: number; needle: string }> =
      [];
    for (const doc of params.documents) {
      if (seen.has(doc.search_document_id)) continue;
      if (!expandTypes.has(doc.knowledge_unit_type)) continue;
      const hay = `${doc.source_key} ${doc.title} ${doc.search_text ?? ""}`.toUpperCase();
      let best = "";
      for (const n of needles) {
        if (hay.includes(n) && n.length > best.length) best = n;
      }
      if (!best) continue;
      // Prefer code and value rows over more profiles
      const typeBonus =
        doc.knowledge_unit_type === "code_unit"
          ? 30
          : doc.knowledge_unit_type === "table_row"
            ? 20
            : 5;
      scored.push({ doc, score: best.length + typeBonus, needle: best });
    }
    scored.sort((a, b) => b.score - a.score);
    // Diversify: prefer code first, then at most a few rows per table, then profiles
    const perTableRows = new Map<string, number>();
    const picked: typeof scored = [];
    for (const row of scored) {
      if (row.doc.knowledge_unit_type === "code_unit") {
        picked.push(row);
        continue;
      }
      if (row.doc.knowledge_unit_type === "table_row") {
        const table = String(row.doc.object_name || row.doc.metadata?.table_name || "")
          .toUpperCase() || row.needle;
        const n = perTableRows.get(table) ?? 0;
        if (n >= 3) continue;
        perTableRows.set(table, n + 1);
        picked.push(row);
        continue;
      }
      picked.push(row);
    }
    const expandBudget = Math.min(
      16,
      Math.max(8, params.limit - promoted.length),
    );
    for (const row of picked.slice(0, expandBudget)) {
      if (seen.has(row.doc.search_document_id)) continue;
      seen.add(row.doc.search_document_id);
      const base = hitFromDoc(
        row.doc,
        {
          doc: {
            id: `expand:${row.doc.search_document_id}`,
            kind: "ddic_field",
            technical_name: row.needle,
            title: row.needle,
            source_path: "",
            search_text: row.doc.search_text ?? "",
          },
          score: 60 + row.score,
          channels: ["partial_substring"],
          boosts: { expand: 60 + row.score },
          matched_phrases: [],
          matched_terms: [row.needle],
          primary_anchor_candidate: false,
        },
        promoted.length + expanded.length + 1,
      );
      expanded.push({
        ...base,
        combined_score: 50 + row.score,
        matched_terms: [`expand:${row.needle}`],
      });
    }
  }

  const rest = params.hybridHits.filter((h) => !seen.has(h.search_document_id));

  const merged = [...promoted, ...expanded, ...rest]
    .slice(0, params.limit)
    .map((h, i) => ({ ...h, rank: i + 1 }));

  return {
    hits: merged,
    promoted: promoted.length + expanded.length,
    primary_fields: primary_fields.slice(0, 5),
    expansion_tokens: [...expansion_tokens],
  };
}
