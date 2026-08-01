import { createHash } from "crypto";
import type { SearchEmbeddingRecord } from "@/lib/search/embedSearchDocuments";
import { getEmbeddingRuntimeConfig } from "@/lib/search/embeddingConfig";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";

export type LocalSearchIndex = {
  exact_index: Record<string, string[]>;
  fulltext_index: Record<string, Array<{ id: string; tf: number }>>;
  metadata_index: Record<
    string,
    {
      knowledge_unit_type: string;
      object_type: string;
      object_name: string;
      subobject_name: string;
      source_key: string;
      confidence: number | null;
      title: string;
    }
  >;
  relation_index: Array<{
    from_id: string;
    relation_type: string;
    to_name: string;
    to_type?: string;
    to_id?: string;
  }>;
  /** Thin vector refs — full vectors live in embeddings/search/search_embeddings.jsonl */
  vector_index: Array<{
    search_document_id: string;
    source_key: string;
    content_hash: string;
    dimensions: number;
  }>;
  manifest: {
    at: string;
    document_count: number;
    embedding_count: number;
    embedding_model: string;
    embedding_version: string;
    dimensions: number;
    content_fingerprint: string;
  };
};

const TOKEN_RE = /[A-Za-zÀ-ÿ0-9_./:=-]+/g;

/** Fold common Latin umlauts/diacritics to ASCII-ish forms for matching. */
export function foldSearchDiacritics(token: string): string {
  return token
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/á|à|â|ã/g, "a")
    .replace(/é|è|ê|ë/g, "e")
    .replace(/í|ì|î|ï/g, "i")
    .replace(/ó|ò|ô|õ/g, "o")
    .replace(/ú|ù|û/g, "u")
    .replace(/ç/g, "c")
    .replace(/ñ/g, "n");
}

/**
 * Expand a single surface token into searchable variants:
 * - original (lowercased, edge punctuation stripped)
 * - diacritic-folded form (für → fuer)
 * - hyphen/underscore parts (coca-cola → coca, cola; set_x → set, x)
 * - glued compound without separators (coca_cola → cocacola)
 *
 * Generic compound normalization — not domain- or customer-specific.
 */
export function expandSearchTokenVariants(rawToken: string): string[] {
  const cleaned = rawToken
    .toLowerCase()
    .replace(/^[^a-z0-9äöüáàâãéèêëíìîïóòôõúùûçñß]+|[^a-z0-9äöüáàâãéèêëíìîïóòôõúùûçñß]+$/gi, "");
  if (cleaned.length < 2) return [];

  const variants = new Set<string>();
  const add = (t: string) => {
    if (t.length >= 2) variants.add(t);
  };

  add(cleaned);
  const folded = foldSearchDiacritics(cleaned);
  add(folded);

  if (/[-_]/.test(cleaned)) {
    // Parts need length >= 4 so short fragments like "set" from SET_X do not flood matches.
    for (const part of cleaned.split(/[-_]+/)) {
      if (part.length < 4) continue;
      add(part);
      add(foldSearchDiacritics(part));
    }
    const glued = cleaned.replace(/[-_]+/g, "");
    add(glued);
    add(foldSearchDiacritics(glued));
  }

  return [...variants];
}

export function tokenizeSearchText(text: string): string[] {
  const raw = text.toLowerCase().match(TOKEN_RE) ?? [];
  const out: string[] = [];
  for (const t of raw) {
    out.push(...expandSearchTokenVariants(t));
  }
  return out;
}

function addExact(map: Record<string, string[]>, key: string, id: string) {
  const k = normalizeSearchToken(key).toUpperCase();
  if (!k) return;
  const list = map[k] ?? [];
  if (!list.includes(id)) list.push(id);
  map[k] = list;
}

export function buildLocalSearchIndex(params: {
  documents: SearchDocument[];
  embeddings: SearchEmbeddingRecord[];
  now?: string;
}): LocalSearchIndex {
  const cfg = getEmbeddingRuntimeConfig();
  const exact_index: LocalSearchIndex["exact_index"] = {};
  const fulltext_index: LocalSearchIndex["fulltext_index"] = {};
  const metadata_index: LocalSearchIndex["metadata_index"] = {};
  const relation_index: LocalSearchIndex["relation_index"] = [];
  const embById = new Map(
    params.embeddings.map((e) => [e.search_document_id, e]),
  );
  const idBySourceKey = new Map(
    params.documents.map((d) => [d.source_key, d.search_document_id]),
  );
  /** Resolve callee units by subobject/unit name (e.g. SET_KONZERNFARBE). */
  const idByUnitName = new Map<string, string>();
  for (const doc of params.documents) {
    const unit = doc.subobject_name?.trim();
    if (unit && !idByUnitName.has(unit.toUpperCase())) {
      idByUnitName.set(unit.toUpperCase(), doc.search_document_id);
    }
  }

  for (const doc of params.documents) {
    const id = doc.search_document_id;
    metadata_index[id] = {
      knowledge_unit_type: doc.knowledge_unit_type,
      object_type: doc.object_type,
      object_name: doc.object_name,
      subobject_name: doc.subobject_name,
      source_key: doc.source_key,
      confidence: doc.confidence,
      title: doc.title,
    };

    addExact(exact_index, doc.source_key, id);
    addExact(exact_index, doc.object_name, id);
    addExact(exact_index, doc.subobject_name, id);
    addExact(exact_index, doc.title, id);
    for (const t of doc.tables_read) addExact(exact_index, t, id);
    for (const t of doc.tables_written) addExact(exact_index, t, id);
    for (const m of doc.called_methods) addExact(exact_index, m, id);
    for (const e of doc.entities) {
      addExact(exact_index, e.name, id);
      if (e.normalized) addExact(exact_index, e.normalized, id);
    }
    for (const hv of doc.hardcoded_values) addExact(exact_index, hv, id);

    const tf = new Map<string, number>();
    for (const tok of tokenizeSearchText(doc.search_text)) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    for (const [tok, count] of tf) {
      const list = fulltext_index[tok] ?? [];
      list.push({ id, tf: count });
      fulltext_index[tok] = list;
    }

    for (const rel of doc.relations) {
      const to_id = rel.to_name
        ? idBySourceKey.get(rel.to_name) ??
          idByUnitName.get(rel.to_name.toUpperCase())
        : undefined;
      relation_index.push({
        from_id: id,
        relation_type: rel.relation_type,
        to_name: rel.to_name ?? "",
        to_type: rel.to_type,
        to_id,
      });
    }

    // Generic CALLS edges from called_methods → callee units (1-hop expansion).
    for (const method of doc.called_methods) {
      const to_id = idByUnitName.get(method.toUpperCase());
      relation_index.push({
        from_id: id,
        relation_type: "CALLS",
        to_name: method,
        to_type: "unit",
        to_id,
      });
    }
  }

  const vector_index: LocalSearchIndex["vector_index"] = [];
  for (const doc of params.documents) {
    const emb = embById.get(doc.search_document_id);
    if (!emb) continue;
    vector_index.push({
      search_document_id: doc.search_document_id,
      source_key: doc.source_key,
      content_hash: doc.content_hash,
      dimensions: emb.dimensions,
    });
  }

  const fingerprint = createHash("sha256")
    .update(
      params.documents
        .map((d) => `${d.search_document_id}:${d.content_hash}`)
        .sort()
        .join("\n"),
      "utf8",
    )
    .digest("hex");

  return {
    exact_index,
    fulltext_index,
    metadata_index,
    relation_index,
    vector_index,
    manifest: {
      at: params.now ?? new Date().toISOString(),
      document_count: params.documents.length,
      embedding_count: vector_index.length,
      embedding_model: cfg.model,
      embedding_version: cfg.version,
      dimensions: cfg.dimensions,
      content_fingerprint: fingerprint,
    },
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
