import { createHash } from "crypto";
import OpenAI from "openai";
import { categorizeOpenAIError, AIProviderError } from "@/lib/ai/errors";
import {
  getEmbeddingRuntimeConfig,
  SEARCH_EMBEDDING_VERSION,
} from "@/lib/search/embeddingConfig";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import {
  askPerfBegin,
  askPerfEnd,
  askPerfRecordOpenAi,
} from "@/lib/knowledge/askPerf";

export type SearchEmbeddingRecord = {
  search_document_id: string;
  source_key: string;
  content_hash: string;
  embedding_model: string;
  embedding_version: string;
  dimensions: number;
  /** Compact Float32 little-endian base64 — preferred storage. */
  vector_b64: string;
  /** Optional legacy expanded vector (avoid for large corpora). */
  vector?: number[];
  input_tokens: number;
  estimated_cost: number;
  created_at: string;
};

export function encodeVectorBase64(vector: number[]): string {
  const buf = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    buf.writeFloatLE(vector[i]!, i * 4);
  }
  return buf.toString("base64");
}

export function decodeVectorBase64(b64: string, dimensions: number): number[] {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== dimensions * 4) {
    throw new Error(
      `vector_b64 Länge ${buf.length} passt nicht zu dimensions=${dimensions}`,
    );
  }
  const out = new Array<number>(dimensions);
  for (let i = 0; i < dimensions; i++) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}

export function embeddingVector(rec: SearchEmbeddingRecord): number[] {
  if (rec.vector_b64) {
    return decodeVectorBase64(rec.vector_b64, rec.dimensions);
  }
  if (rec.vector && rec.vector.length === rec.dimensions) return rec.vector;
  throw new Error(`Embedding ohne Vektor: ${rec.search_document_id}`);
}

export type EmbedSearchDocumentsResult = {
  records: SearchEmbeddingRecord[];
  created: number;
  skipped_unchanged: number;
  input_tokens: number;
  estimated_cost: number;
};

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new AIProviderError({
      message: "OPENAI_API_KEY nicht konfiguriert",
      category: "not_configured",
      retryable: false,
    });
  }
  return key;
}

function embeddingSkipKey(params: {
  content_hash: string;
  embedding_model: string;
  embedding_version: string;
}): string {
  return createHash("sha256")
    .update(
      `${params.content_hash}|${params.embedding_model}|${params.embedding_version}`,
      "utf8",
    )
    .digest("hex");
}

export function parseEmbeddingsJsonl(text: string): Map<string, SearchEmbeddingRecord> {
  const map = new Map<string, SearchEmbeddingRecord>();
  if (!text.trim()) return map;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const row = JSON.parse(raw) as SearchEmbeddingRecord;
    if (!row.search_document_id) continue;
    map.set(row.search_document_id, row);
  }
  return map;
}

export function embeddingsToJsonl(rows: Iterable<SearchEmbeddingRecord>): string {
  const list = [...rows];
  if (list.length === 0) return "";
  return `${list.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

async function embedBatch(params: {
  texts: string[];
  model: string;
  dimensions: number;
}): Promise<{ vectors: number[][]; input_tokens: number }> {
  try {
    const client = new OpenAI({
      apiKey: requireApiKey(),
      timeout: 120_000,
      maxRetries: 2,
    });
    const response = await client.embeddings.create({
      model: params.model,
      input: params.texts,
      dimensions: params.dimensions,
    });
    const byIndex = [...response.data].sort((a, b) => a.index - b.index);
    const vectors = byIndex.map((row) => {
      if (row.embedding.length !== params.dimensions) {
        throw new AIProviderError({
          message: `Unerwartete Embedding-Dimension ${row.embedding.length}`,
          category: "provider",
          retryable: false,
        });
      }
      return row.embedding;
    });
    return {
      vectors,
      input_tokens: response.usage?.total_tokens ?? 0,
    };
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    const info = categorizeOpenAIError(error);
    throw new AIProviderError({
      message: info.message,
      category: info.category,
      status: info.status,
      retryable: info.retryable,
      cause: error,
    });
  }
}

/**
 * Incremental embeddings keyed by content_hash + model + embedding_version.
 * With `replaceCorpus: true`, only embeddings for the given documents are kept.
 */
export async function embedSearchDocuments(params: {
  documents: SearchDocument[];
  existingJsonl?: string;
  batchSize?: number;
  now?: string;
  replaceCorpus?: boolean;
  /** Optional flush after each batch (e.g. persist mid-run). */
  onBatch?: (records: SearchEmbeddingRecord[]) => void;
}): Promise<EmbedSearchDocumentsResult> {
  const cfg = getEmbeddingRuntimeConfig();
  const existing = parseEmbeddingsJsonl(params.existingJsonl ?? "");
  const byId = new Map(existing);
  const batchSize = params.batchSize ?? 64;
  const now = params.now ?? new Date().toISOString();
  const keepIds = new Set(params.documents.map((d) => d.search_document_id));

  let created = 0;
  let skipped_unchanged = 0;
  let input_tokens = 0;
  let estimated_cost = 0;

  const pending: SearchDocument[] = [];
  for (const doc of params.documents) {
    const prior = byId.get(doc.search_document_id);
    const skipKey = embeddingSkipKey({
      content_hash: doc.content_hash,
      embedding_model: cfg.model,
      embedding_version: cfg.version,
    });
    const priorKey = prior
      ? embeddingSkipKey({
          content_hash: prior.content_hash,
          embedding_model: prior.embedding_model,
          embedding_version: prior.embedding_version,
        })
      : null;
    if (
      prior &&
      priorKey === skipKey &&
      prior.dimensions === cfg.dimensions &&
      ((prior.vector_b64 &&
        Buffer.from(prior.vector_b64, "base64").length === cfg.dimensions * 4) ||
        prior.vector?.length === cfg.dimensions)
    ) {
      skipped_unchanged += 1;
      continue;
    }
    pending.push(doc);
  }

  for (let i = 0; i < pending.length; i += batchSize) {
    const chunk = pending.slice(i, i + batchSize);
    const { vectors, input_tokens: tokens } = await embedBatch({
      texts: chunk.map((d) => d.search_text || d.title),
      model: cfg.model,
      dimensions: cfg.dimensions,
    });
    input_tokens += tokens;
    const cost = (tokens / 1_000_000) * cfg.pricePer1MInput;
    estimated_cost += cost;
    const perDocTokens = Math.round(tokens / Math.max(1, chunk.length));
    const perDocCost = cost / Math.max(1, chunk.length);

    for (let j = 0; j < chunk.length; j++) {
      const doc = chunk[j]!;
      const vector = vectors[j]!;
      byId.set(doc.search_document_id, {
        search_document_id: doc.search_document_id,
        source_key: doc.source_key,
        content_hash: doc.content_hash,
        embedding_model: cfg.model,
        embedding_version: SEARCH_EMBEDDING_VERSION,
        dimensions: cfg.dimensions,
        vector_b64: encodeVectorBase64(vector),
        input_tokens: perDocTokens,
        estimated_cost: Number(perDocCost.toFixed(8)),
        created_at: now,
      });
      created += 1;
    }
    if (params.onBatch) {
      const snapshot = params.replaceCorpus
        ? [...byId.values()].filter((r) => keepIds.has(r.search_document_id))
        : [...byId.values()];
      params.onBatch(snapshot);
    }
  }

  const records = (
    params.replaceCorpus
      ? [...byId.values()].filter((r) => keepIds.has(r.search_document_id))
      : [...byId.values()]
  ).sort((a, b) => a.search_document_id.localeCompare(b.search_document_id));

  return {
    records,
    created,
    skipped_unchanged,
    input_tokens,
    estimated_cost: Number(estimated_cost.toFixed(6)),
  };
}

export async function embedQueryText(query: string): Promise<{
  vector: number[];
  model: string;
  dimensions: number;
  input_tokens: number;
  estimated_cost: number;
}> {
  askPerfBegin("openai_embedding");
  const t0 = performance.now();
  const cfg = getEmbeddingRuntimeConfig();
  const { vectors, input_tokens } = await embedBatch({
    texts: [query],
    model: cfg.model,
    dimensions: cfg.dimensions,
  });
  const ms = performance.now() - t0;
  askPerfRecordOpenAi(ms);
  askPerfEnd("openai_embedding");
  return {
    vector: vectors[0]!,
    model: cfg.model,
    dimensions: cfg.dimensions,
    input_tokens,
    estimated_cost: Number(
      ((input_tokens / 1_000_000) * cfg.pricePer1MInput).toFixed(8),
    ),
  };
}
