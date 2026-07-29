/**
 * Owner-only OpenAI health check against Vercel Production.
 * Uses Supabase password login + session cookies; never prints the API key.
 *
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY (or PUBLISHABLE)
 *   OPENAI_HEALTH_OWNER_EMAIL (default: owner.phase1@general-agent.test)
 *   OPENAI_HEALTH_OWNER_PASSWORD
 *   PRODUCTION_APP_URL (optional override)
 *   VERCEL_AUTOMATION_BYPASS_SECRET (optional, for Deployment Protection)
 *
 * Run: npx tsx scripts/openai-health-production.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

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
      let value = normalized.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key] || process.env[key]?.trim() === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // optional
  }
}

async function resolveProductionUrl(): Promise<string> {
  if (process.env.PRODUCTION_APP_URL?.trim()) {
    return process.env.PRODUCTION_APP_URL.trim().replace(/\/$/, "");
  }

  const res = await fetch(
    "https://api.github.com/repos/danielsoboll/Universal-agent/deployments?per_page=5",
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) {
    throw new Error(`GitHub deployments unavailable (${res.status})`);
  }
  const deployments = (await res.json()) as Array<{
    id: number;
    environment?: string;
    sha?: string;
  }>;
  const production = deployments.find((d) => d.environment === "Production");
  if (!production) {
    throw new Error("No Production deployment found");
  }

  const statusRes = await fetch(
    `https://api.github.com/repos/danielsoboll/Universal-agent/deployments/${production.id}/statuses`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!statusRes.ok) {
    throw new Error(`GitHub deployment statuses unavailable (${statusRes.status})`);
  }
  const statuses = (await statusRes.json()) as Array<{
    state?: string;
    environment_url?: string;
  }>;
  const success = statuses.find(
    (s) => s.state === "success" && s.environment_url,
  );
  if (!success?.environment_url) {
    throw new Error("No successful Production environment_url");
  }
  return success.environment_url.replace(/\/$/, "");
}

function chunkCookieValue(value: string, chunkSize = 3180): string[] {
  if (value.length <= chunkSize) return [value];
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += chunkSize) {
    chunks.push(value.slice(i, i + chunkSize));
  }
  return chunks;
}

async function main() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const email =
    process.env.OPENAI_HEALTH_OWNER_EMAIL?.trim() ||
    "owner.phase1@general-agent.test";
  const password =
    process.env.OPENAI_HEALTH_OWNER_PASSWORD?.trim() ||
    "Test-Passwort-Phase1!";

  if (!url || !anon) {
    console.log(
      JSON.stringify({
        erreichbar: "nein",
        modell: null,
        laufzeit_ms: 0,
        fehlerkategorie: "not_configured",
        error: "Supabase public env fehlt für Production-Login.",
      }),
    );
    process.exitCode = 1;
    return;
  }

  const productionUrl = await resolveProductionUrl();
  const auth = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    console.log(
      JSON.stringify({
        erreichbar: "nein",
        modell: null,
        laufzeit_ms: 0,
        fehlerkategorie: "auth",
        error: "Owner-Login fehlgeschlagen.",
      }),
    );
    process.exitCode = 1;
    return;
  }

  const projectRef = new URL(url).hostname.split(".")[0];
  const cookieName = `sb-${projectRef}-auth-token`;
  const sessionPayload = JSON.stringify({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    expires_in: data.session.expires_in,
    token_type: data.session.token_type,
    user: data.session.user,
  });
  const encoded = encodeURIComponent(sessionPayload);
  const chunks = chunkCookieValue(encoded);
  const cookieHeader =
    chunks.length === 1
      ? `${cookieName}=${chunks[0]}`
      : chunks
          .map((chunk, index) => `${cookieName}.${index}=${chunk}`)
          .join("; ");

  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "application/json",
  };
  if (bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
  }

  const started = Date.now();
  const response = await fetch(`${productionUrl}/api/internal/openai-health`, {
    method: "POST",
    headers,
    redirect: "manual",
  });
  const elapsed = Date.now() - started;
  const text = await response.text();

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {
      error: "Non-JSON response (likely Vercel SSO / HTML).",
      status: response.status,
      preview: text.slice(0, 120),
    };
  }

  // Never echo secrets if somehow present
  const safe = JSON.parse(
    JSON.stringify(body).replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]"),
  ) as Record<string, unknown>;

  console.log(
    JSON.stringify(
      {
        production_url: productionUrl,
        http_status: response.status,
        erreichbar: safe.erreichbar ?? "nein",
        modell: safe.modell ?? null,
        laufzeit_ms: safe.laufzeit_ms ?? elapsed,
        fehlerkategorie: safe.fehlerkategorie ?? null,
        error: safe.error ?? null,
      },
      null,
      2,
    ),
  );

  if (response.status !== 200 || safe.erreichbar !== "ja") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      erreichbar: "nein",
      modell: null,
      laufzeit_ms: 0,
      fehlerkategorie: "unknown",
      error: error instanceof Error ? error.message : "unknown",
    }),
  );
  process.exit(1);
});
