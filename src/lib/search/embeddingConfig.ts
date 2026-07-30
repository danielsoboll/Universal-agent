import { AI_CONFIG } from "@/lib/ai/config";

export const SEARCH_EMBEDDING_VERSION = "search-embedding-v1";

export type EmbeddingRuntimeConfig = {
  model: string;
  dimensions: number;
  version: string;
  /** USD per 1M input tokens */
  pricePer1MInput: number;
};

/**
 * Embedding settings from env/AI_CONFIG only — never hardcode model names in feature code.
 */
export function getEmbeddingRuntimeConfig(): EmbeddingRuntimeConfig {
  const model =
    process.env.OPENAI_EMBEDDING_MODEL?.trim() || AI_CONFIG.embeddingModel;
  const dimRaw = process.env.OPENAI_EMBEDDING_DIMENSIONS?.trim();
  const dimensions = dimRaw
    ? Number.parseInt(dimRaw, 10)
    : AI_CONFIG.embeddingDimensions;
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error("OPENAI_EMBEDDING_DIMENSIONS ungültig");
  }
  const pricing = AI_CONFIG.pricingUsdPer1M[model] ?? { input: 0.02, output: 0 };
  return {
    model,
    dimensions,
    version: SEARCH_EMBEDDING_VERSION,
    pricePer1MInput: pricing.input,
  };
}
