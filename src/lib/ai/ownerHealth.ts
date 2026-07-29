import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getAIProvider } from "@/lib/ai/provider";
import { AI_CONFIG } from "@/lib/ai/config";
import { logAiUsage } from "@/lib/ai/usageLog";
import type { AIErrorCategory } from "@/lib/ai/errors";

export type OpenAIHealthReport = {
  erreichbar: "ja" | "nein";
  modell: string;
  laufzeit_ms: number;
  fehlerkategorie: AIErrorCategory | null;
};

export async function assertOwnerCanRunHealthCheck(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) {
    console.error("[openai-health] auth failed", {
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
    console.error("[openai-health] ownership check failed", {
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

export async function runOwnerOpenAIHealthCheck(): Promise<
  | { ok: true; report: OpenAIHealthReport }
  | { ok: false; error: string; report: OpenAIHealthReport | null }
> {
  const access = await assertOwnerCanRunHealthCheck();
  if (!access.ok) {
    return { ok: false, error: access.error, report: null };
  }

  const provider = getAIProvider();
  const result = await provider.testConnection();

  const report: OpenAIHealthReport = {
    erreichbar: result.reachable ? "ja" : "nein",
    modell: result.model || AI_CONFIG.chatModel,
    laufzeit_ms: result.durationMs,
    fehlerkategorie: result.errorCategory,
  };

  await logAiUsage({
    projectId: null,
    provider: provider.name,
    model: report.modell,
    task: "provider_health_check",
    inputTokens: null,
    outputTokens: null,
    durationMs: report.laufzeit_ms,
    metadata: {
      reachable: result.reachable,
      error_category: result.errorCategory,
      triggered_by: access.userId,
    },
  });

  return { ok: true, report };
}
