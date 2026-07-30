import { createHash } from "crypto";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";
import { AI_CONFIG } from "@/lib/ai/config";
import { AIProviderError, categorizeOpenAIError } from "@/lib/ai/errors";

export type StructuredCallResult<T> = {
  data: T;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  duration_ms: number;
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

export function estimateCostUsd(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  const pricing = AI_CONFIG.pricingUsdPer1M[params.model] ?? {
    input: 0.4,
    output: 1.6,
  };
  return (
    (params.inputTokens / 1_000_000) * pricing.input +
    (params.outputTokens / 1_000_000) * pricing.output
  );
}

/**
 * Structured OpenAI call with usage/cost — pilot-local, uses AI_CONFIG.chatModel.
 * Does not change the shared provider API.
 */
export async function generateStructuredWithUsage<T>(params: {
  schema: ZodType<T>;
  schemaName: string;
  system: string;
  user: string;
  model?: string;
  timeoutMs?: number;
}): Promise<StructuredCallResult<T>> {
  const model = params.model ?? AI_CONFIG.chatModel;
  const timeoutMs = params.timeoutMs ?? AI_CONFIG.analysisTimeoutMs;
  const started = Date.now();

  try {
    const client = new OpenAI({
      apiKey: requireApiKey(),
      timeout: timeoutMs,
      maxRetries: AI_CONFIG.maxRetries,
    });
    const completion = await client.chat.completions.parse(
      {
        model,
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.user },
        ],
        response_format: zodResponseFormat(params.schema, params.schemaName),
      },
      { timeout: timeoutMs },
    );

    const parsed = completion.choices[0]?.message?.parsed;
    if (parsed == null) {
      throw new AIProviderError({
        message: "Strukturierte Antwort fehlt.",
        category: "provider",
        retryable: true,
      });
    }

    const input_tokens = completion.usage?.prompt_tokens ?? 0;
    const output_tokens = completion.usage?.completion_tokens ?? 0;
    return {
      data: parsed as T,
      model,
      input_tokens,
      output_tokens,
      estimated_cost: estimateCostUsd({
        model,
        inputTokens: input_tokens,
        outputTokens: output_tokens,
      }),
      duration_ms: Date.now() - started,
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

export function sha256Stable(value: unknown): string {
  const canonical = JSON.stringify(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
