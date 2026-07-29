"use server";

import { createClient } from "@/lib/supabase/server";
import { getAIProvider } from "@/lib/ai/provider";
import { AI_CONFIG } from "@/lib/ai/config";
import { logAiUsage } from "@/lib/ai/usageLog";
import type { ProviderHealthResult } from "@/lib/ai/types";
import type { AIErrorCategory } from "@/lib/ai/errors";

export type AiHealthActionState = {
  error: string | null;
  result: ProviderHealthResult | null;
};

async function assertOwnerCanRunHealthCheck(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) {
    console.error("[testOpenAIConnection] auth failed", {
      message: authError.message,
    });
    return { ok: false, error: "Anmeldung konnte nicht geprüft werden." };
  }

  if (!user) {
    return { ok: false, error: "Nicht angemeldet." };
  }

  const { data: ownership, error: ownershipError } = await supabase
    .from("project_members")
    .select("project_id")
    .eq("user_id", user.id)
    .eq("role", "owner")
    .eq("is_active", true)
    .limit(1);

  if (ownershipError) {
    console.error("[testOpenAIConnection] ownership check failed", {
      message: ownershipError.message,
      code: ownershipError.code,
    });
    return {
      ok: false,
      error: "Berechtigung konnte nicht geprüft werden.",
    };
  }

  if (!ownership || ownership.length === 0) {
    return {
      ok: false,
      error: "Nur Projekt-Owner dürfen den Provider-Test ausführen.",
    };
  }

  return { ok: true, userId: user.id };
}

export async function testOpenAIConnection(
  _prev: AiHealthActionState,
  _formData: FormData,
): Promise<AiHealthActionState> {
  try {
    const access = await assertOwnerCanRunHealthCheck();
    if (!access.ok) {
      return { error: access.error, result: null };
    }

    const provider = getAIProvider();
    const result = await provider.testConnection();

    await logAiUsage({
      projectId: null,
      provider: provider.name,
      model: result.model || AI_CONFIG.chatModel,
      task: "provider_health_check",
      inputTokens: null,
      outputTokens: null,
      durationMs: result.durationMs,
      metadata: {
        reachable: result.reachable,
        error_category: result.errorCategory,
        triggered_by: access.userId,
      },
    });

    if (!result.reachable) {
      return {
        error: null,
        result: {
          reachable: false,
          model: result.model,
          durationMs: result.durationMs,
          errorCategory: result.errorCategory,
          message: result.message,
        },
      };
    }

    return { error: null, result };
  } catch (error) {
    const category: AIErrorCategory =
      error instanceof Error && "category" in error
        ? ((error as { category: AIErrorCategory }).category ?? "unknown")
        : "unknown";
    console.error("[testOpenAIConnection] unexpected", { category });
    return {
      error: "Provider-Test fehlgeschlagen. Bitte später erneut versuchen.",
      result: null,
    };
  }
}

/** Whether the current user may see/run the technical provider health UI. */
export async function canRunProviderHealthCheck(): Promise<boolean> {
  const access = await assertOwnerCanRunHealthCheck();
  return access.ok;
}
