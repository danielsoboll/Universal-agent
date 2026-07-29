/**
 * Server-side OpenAI health check (CLI).
 * Run: npx tsx scripts/openai-health.ts
 * Requires OPENAI_API_KEY in .env.local — never prints the key.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2];
      }
    }
  } catch {
    // optional
  }
}

async function main() {
  loadEnv();

  // Dynamic import after env load; avoid pulling Next server-only into wrong graph.
  const { OpenAIProvider } = await import("../src/lib/ai/openaiProvider");
  const { logAiUsage } = await import("../src/lib/ai/usageLog");
  const { AI_CONFIG } = await import("../src/lib/ai/config");

  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (!hasKey) {
    console.log(
      JSON.stringify(
        {
          reachable: false,
          model: AI_CONFIG.chatModel,
          durationMs: 0,
          errorCategory: "not_configured",
          message: "OPENAI_API_KEY fehlt in der Umgebung.",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const provider = new OpenAIProvider();
  const result = await provider.testConnection();

  try {
    await logAiUsage({
      projectId: null,
      provider: provider.name,
      model: result.model,
      task: "provider_health_check_cli",
      durationMs: result.durationMs,
      metadata: {
        reachable: result.reachable,
        error_category: result.errorCategory,
        source: "cli",
      },
    });
  } catch {
    // logging is optional for CLI
  }

  console.log(
    JSON.stringify(
      {
        reachable: result.reachable,
        model: result.model,
        durationMs: result.durationMs,
        errorCategory: result.errorCategory,
        message: result.message,
      },
      null,
      2,
    ),
  );

  if (!result.reachable) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      reachable: false,
      errorCategory: "unknown",
      message: error instanceof Error ? error.message : "CLI-Fehler",
    }),
  );
  process.exit(1);
});
