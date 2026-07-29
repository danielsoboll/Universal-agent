"use server";

import {
  assertOwnerCanRunHealthCheck,
  runOwnerOpenAIHealthCheck,
  type OpenAIHealthReport,
} from "@/lib/ai/ownerHealth";
import type { AIErrorCategory } from "@/lib/ai/errors";

export type AiHealthActionState = {
  error: string | null;
  report: OpenAIHealthReport | null;
};

export async function testOpenAIConnection(
  _prev: AiHealthActionState,
  _formData: FormData,
): Promise<AiHealthActionState> {
  try {
    const outcome = await runOwnerOpenAIHealthCheck();
    if (!outcome.ok && outcome.report == null) {
      return { error: outcome.error, report: null };
    }
    return { error: null, report: outcome.report };
  } catch (error) {
    const category: AIErrorCategory =
      error instanceof Error && "category" in error
        ? ((error as { category: AIErrorCategory }).category ?? "unknown")
        : "unknown";
    console.error("[openai-health] unexpected", { category });
    return {
      error: "Provider-Test fehlgeschlagen. Bitte später erneut versuchen.",
      report: null,
    };
  }
}

/** Whether the current user may see/run the technical provider health UI. */
export async function canRunProviderHealthCheck(): Promise<boolean> {
  const access = await assertOwnerCanRunHealthCheck();
  return access.ok;
}
