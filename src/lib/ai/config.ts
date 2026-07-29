/** Central AI model configuration — do not scatter model names in feature code. */
export const AI_CONFIG = {
  provider: "openai" as const,
  /** Chat / structured-output model */
  chatModel: "gpt-4.1-mini",
  /** Embedding model — must stay aligned with vector(1536) in schema */
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 1536,
  timeoutMs: 30_000,
  /** SDK retries for transient 408/429/5xx */
  maxRetries: 2,
  /** Rough USD per 1M tokens for optional cost estimates (only when usage is known). */
  pricingUsdPer1M: {
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "text-embedding-3-small": { input: 0.02, output: 0 },
  } as Record<string, { input: number; output: number }>,
} as const;

export type AiProviderName = typeof AI_CONFIG.provider;
