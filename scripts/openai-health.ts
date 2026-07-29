/**
 * Server-side OpenAI health check (CLI).
 * Run: npm run openai:health
 * Requires OPENAI_API_KEY in .env.local — never prints the key or prompts.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q)) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function loadEnvFile(filename: string) {
  try {
    const text = readFileSync(resolve(process.cwd(), filename), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ")
        ? line.slice("export ".length).trim()
        : line;
      const eq = normalized.indexOf("=");
      if (eq <= 0) continue;
      const key = normalized.slice(0, eq).trim();
      const value = stripQuotes(normalized.slice(eq + 1));
      if (!key) continue;
      // Prefer non-empty file values over empty inherited env.
      if (!process.env[key] || process.env[key]?.trim() === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // optional
  }
}

function loadEnv() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");
}

async function main() {
  loadEnv();

  const { OpenAIProvider } = await import("../src/lib/ai/openaiProvider");
  const { logAiUsage } = await import("../src/lib/ai/usageLog");
  const { AI_CONFIG } = await import("../src/lib/ai/config");

  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (!hasKey) {
    console.log(
      JSON.stringify(
        {
          erreichbar: "nein",
          modell: AI_CONFIG.chatModel,
          laufzeit_ms: 0,
          fehlerkategorie: "not_configured",
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
        erreichbar: result.reachable ? "ja" : "nein",
        modell: result.model,
        laufzeit_ms: result.durationMs,
        fehlerkategorie: result.errorCategory,
      },
      null,
      2,
    ),
  );

  if (!result.reachable) process.exitCode = 1;
}

main().catch(() => {
  console.log(
    JSON.stringify({
      erreichbar: "nein",
      modell: null,
      laufzeit_ms: 0,
      fehlerkategorie: "unknown",
    }),
  );
  process.exit(1);
});
