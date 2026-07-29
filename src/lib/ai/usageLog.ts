import { AI_CONFIG } from "@/lib/ai/config";
import { createAdminClient } from "@/lib/supabase/admin";

export type AiUsageLogInput = {
  projectId?: string | null;
  provider: string;
  model: string;
  task: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
};

function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = AI_CONFIG.pricingUsdPer1M[model];
  if (!pricing) return null;
  const cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;
  return Number.isFinite(cost) ? Number(cost.toFixed(6)) : null;
}

/**
 * Writes usage via service role. Never stores prompt/response content.
 * project_id may be null for global health checks.
 */
export async function logAiUsage(input: AiUsageLogInput): Promise<void> {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const estimated = estimateCostUsd(input.model, inputTokens, outputTokens);

  const metadata = {
    ...(input.metadata ?? {}),
    // Explicitly forbid prompt fields even if callers pass them
  };
  delete (metadata as { prompt?: unknown }).prompt;
  delete (metadata as { messages?: unknown }).messages;
  delete (metadata as { input?: unknown }).input;
  delete (metadata as { output?: unknown }).output;
  delete (metadata as { response?: unknown }).response;

  try {
    const admin = createAdminClient();
    const { error } = await admin.from("ai_usage_logs").insert({
      project_id: input.projectId ?? null,
      provider: input.provider,
      model: input.model,
      task: input.task,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: estimated ?? 0,
      duration_ms: input.durationMs ?? null,
      metadata: {
        ...metadata,
        cost_estimated: estimated != null,
      },
    });

    if (error) {
      console.error("[ai_usage_logs] insert failed", {
        code: error.code,
        message: error.message,
        task: input.task,
        model: input.model,
      });
    }
  } catch (error) {
    console.error("[ai_usage_logs] unavailable", {
      task: input.task,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}
