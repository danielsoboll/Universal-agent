/**
 * Onboarding RLS tests against linked Supabase.
 * Run: npx tsx scripts/onboarding-rls-tests.ts
 * Requires migrations applied + SUPABASE_* in .env.local
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}

loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const service =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function ensureUser(admin: SupabaseClient, email: string, password: string) {
  const listed = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = listed.data.users.find((u) => u.email === email);
  if (existing) {
    await admin.auth.admin.updateUserById(existing.id, { password });
    return existing.id;
  }
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(created.error?.message ?? "createUser failed");
  }
  return created.data.user.id;
}

async function signIn(email: string, password: string) {
  const client = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(error?.message ?? "signIn failed");
  return data.session.access_token;
}

function authed(token: string) {
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function main() {
  if (!url || !anon || !service) {
    console.error("Missing Supabase env");
    process.exit(1);
  }

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Detect schema
  const probe = await admin.from("customers").select("id").limit(1);
  if (probe.error) {
    console.error(
      "customers table missing — apply onboarding migrations first:",
      probe.error.message,
    );
    process.exit(2);
  }

  const pwd = "Test-Onboarding-RLS-1!";
  const platformId = await ensureUser(admin, "rls-platform@example.com", pwd);
  const adminAId = await ensureUser(admin, "rls-cust-admin@example.com", pwd);
  const userAId = await ensureUser(admin, "rls-cust-user@example.com", pwd);
  const adminBId = await ensureUser(admin, "rls-other-admin@example.com", pwd);

  await admin.from("platform_admins").upsert({ user_id: platformId });

  const { data: custA, error: cErr } = await admin
    .from("customers")
    .upsert(
      {
        slug: "rls-demo-a",
        name: "RLS Demo A",
        status: "onboarding",
        created_by: platformId,
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (cErr || !custA) throw new Error(cErr?.message ?? "custA");

  const { data: custB } = await admin
    .from("customers")
    .upsert(
      {
        slug: "rls-demo-b",
        name: "RLS Demo B",
        status: "onboarding",
        created_by: platformId,
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();

  await admin.from("customer_memberships").upsert(
    {
      customer_id: custA.id,
      user_id: adminAId,
      role: "customer_admin",
      status: "active",
    },
    { onConflict: "customer_id,user_id" },
  );
  await admin.from("customer_memberships").upsert(
    {
      customer_id: custA.id,
      user_id: userAId,
      role: "customer_user",
      status: "active",
    },
    { onConflict: "customer_id,user_id" },
  );
  await admin.from("customer_memberships").upsert(
    {
      customer_id: custB!.id,
      user_id: adminBId,
      role: "customer_admin",
      status: "active",
    },
    { onConflict: "customer_id,user_id" },
  );

  const tokenPlatform = await signIn("rls-platform@example.com", pwd);
  const tokenAdminA = await signIn("rls-cust-admin@example.com", pwd);
  const tokenUserA = await signIn("rls-cust-user@example.com", pwd);
  const tokenAdminB = await signIn("rls-other-admin@example.com", pwd);

  {
    const { data } = await authed(tokenPlatform).from("customers").select("id");
    record(
      "platform_admin sees customers",
      (data?.length ?? 0) >= 2,
      `count=${data?.length}`,
    );
  }

  {
    const { data } = await authed(tokenAdminA).from("customers").select("id, slug");
    const slugs = (data ?? []).map((c) => c.slug);
    record(
      "customer_admin A only own tenant",
      slugs.includes("rls-demo-a") && !slugs.includes("rls-demo-b"),
      slugs.join(","),
    );
  }

  {
    const { data, error } = await authed(tokenUserA)
      .from("customers")
      .select("id")
      .eq("id", custA.id);
    record("customer_user can read own customer", Boolean(data?.length), error?.message);
  }

  {
    const { data, error } = await authed(tokenUserA)
      .from("customer_workflow_steps")
      .insert({
        customer_workflow_id: "00000000-0000-4000-8000-000000000001",
        customer_id: custA.id,
        step_key: "hack",
        phase_key: "vorbereitung",
        title: "hack",
        sort_order: 1,
        status: "ready",
      });
    record(
      "customer_user cannot insert workflow steps",
      Boolean(error) || !data,
      error?.message ?? "unexpected success",
    );
  }

  {
    const { data } = await authed(tokenAdminB)
      .from("customers")
      .select("id")
      .eq("id", custA.id);
    record("other customer admin cannot read A", (data?.length ?? 0) === 0);
  }

  {
    const badPath = `${custB!.id}/file.jsonl`;
    const { error } = await authed(tokenAdminA).from("source_uploads").insert({
      customer_id: custA.id,
      adapter_key: "documents",
      original_filename: "x.jsonl",
      storage_path: badPath,
      status: "uploaded",
    });
    record(
      "upload path must match customer_id",
      Boolean(error),
      error?.message ?? "constraint should fail",
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
