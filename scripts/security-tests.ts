/**
 * Phase-1 security tests against linked Supabase project.
 * Run: npx tsx scripts/security-tests.ts
 * Requires SUPABASE_* in .env.local
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const service =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function userClient(accessToken?: string) {
  const client = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  if (accessToken) {
    return createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

async function ensureUser(
  admin: SupabaseClient,
  email: string,
  password: string,
) {
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
    throw new Error(`createUser ${email}: ${created.error?.message}`);
  }
  return created.data.user.id;
}

async function signIn(email: string, password: string) {
  const client = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session) {
    throw new Error(`signIn ${email}: ${error?.message}`);
  }
  return data.session.access_token;
}

async function main() {
  if (!url || !anon || !service) {
    throw new Error("Missing env URL / publishable / secret");
  }

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const password = "Test-Passwort-Phase1!";
  const ownerEmail = "owner.phase1@general-agent.test";
  const viewerEmail = "viewer.phase1@general-agent.test";

  const ownerId = await ensureUser(admin, ownerEmail, password);
  const viewerId = await ensureUser(admin, viewerEmail, password);

  // Clean previous test projects by name prefix via service role
  const { data: oldProjects } = await admin
    .from("projects")
    .select("id, name")
    .like("name", "SEC-TEST-%");
  for (const p of oldProjects ?? []) {
    await admin.storage.from("source-originals").remove(
      (
        await admin.storage.from("source-originals").list(p.id)
      ).data?.flatMap((folder) =>
        folder.name
          ? [`${p.id}/${folder.name}`]
          : [],
      ) ?? [],
    );
    await admin.from("projects").delete().eq("id", p.id);
  }

  const { data: projectA, error: aErr } = await admin
    .from("projects")
    .insert({
      name: "SEC-TEST-A",
      description: "Owner project",
      owner_id: ownerId,
    })
    .select("id")
    .single();
  if (aErr || !projectA) throw aErr;

  const { data: projectB, error: bErr } = await admin
    .from("projects")
    .insert({
      name: "SEC-TEST-B",
      description: "Other project",
      owner_id: ownerId,
    })
    .select("id")
    .single();
  if (bErr || !projectB) throw bErr;

  // Owner is auto-added by trigger. Add viewer to A only.
  await admin.from("project_members").upsert({
    project_id: projectA.id,
    user_id: viewerId,
    role: "viewer",
    is_active: true,
  });

  // Seed a source + storage object in B (foreign to viewer)
  const { data: sourceB } = await admin
    .from("sources")
    .insert({
      project_id: projectB.id,
      name: "secret.txt",
      source_type: "txt",
      original_filename: "secret.txt",
      processing_status: "uploaded",
    })
    .select("id")
    .single();

  const foreignPath = `${projectB.id}/${sourceB!.id}/secret.txt`;
  await admin.storage
    .from("source-originals")
    .upload(foreignPath, Buffer.from("top-secret"), {
      contentType: "text/plain",
      upsert: true,
    });
  await admin
    .from("sources")
    .update({ storage_path: foreignPath })
    .eq("id", sourceB!.id);

  // 1) anon has no project access
  const anonClient = userClient();
  const anonProjects = await anonClient.from("projects").select("id");
  record(
    "anon hat keinen Zugriff auf projects",
    (anonProjects.data ?? []).length === 0,
    anonProjects.error?.message ?? `rows=${anonProjects.data?.length}`,
  );

  // 2) viewer without membership on B sees nothing of B
  const viewerToken = await signIn(viewerEmail, password);
  const viewer = userClient(viewerToken);
  const viewerSeesB = await viewer
    .from("projects")
    .select("id")
    .eq("id", projectB.id)
    .maybeSingle();
  record(
    "Nutzer ohne Mitgliedschaft sieht fremdes Projekt nicht",
    viewerSeesB.data == null,
    viewerSeesB.error?.message,
  );

  // 3) viewer can read A and ask chat
  const viewerSeesA = await viewer
    .from("projects")
    .select("id, name")
    .eq("id", projectA.id)
    .maybeSingle();
  record("Viewer kann eigenes Projekt lesen", viewerSeesA.data?.id === projectA.id);

  const sessionIns = await viewer
    .from("chat_sessions")
    .insert({ project_id: projectA.id, title: "Viewer Frage" })
    .select("id")
    .single();
  const msgIns = sessionIns.data
    ? await viewer.from("chat_messages").insert({
        project_id: projectA.id,
        chat_session_id: sessionIns.data.id,
        role: "user",
        content: "Hallo als Viewer",
      })
    : { error: sessionIns.error, data: null };
  record(
    "Viewer kann Chat-Fragen stellen",
    !sessionIns.error && !msgIns.error,
    sessionIns.error?.message || msgIns.error?.message,
  );

  // 4) viewer cannot mutate sources
  const viewerSource = await viewer.from("sources").insert({
    project_id: projectA.id,
    name: "hack.txt",
    source_type: "txt",
  });
  record(
    "Viewer kann Sources nicht anlegen",
    !!viewerSource.error,
    viewerSource.error?.message,
  );

  // 5) editor can manage sources/jobs — promote viewer temporarily? use owner as editor check via second membership
  // Create editor user
  const editorEmail = "editor.phase1@general-agent.test";
  const editorId = await ensureUser(admin, editorEmail, password);
  await admin.from("project_members").upsert({
    project_id: projectA.id,
    user_id: editorId,
    role: "editor",
    is_active: true,
  });
  const editorToken = await signIn(editorEmail, password);
  const editor = userClient(editorToken);

  const editorSource = await editor
    .from("sources")
    .insert({
      project_id: projectA.id,
      name: "ok.txt",
      source_type: "txt",
      processing_status: "uploaded",
    })
    .select("id")
    .single();
  record(
    "Editor kann Sources anlegen",
    !!editorSource.data && !editorSource.error,
    editorSource.error?.message,
  );

  const editorJob = editorSource.data
    ? await editor
        .from("processing_jobs")
        .insert({
          project_id: projectA.id,
          source_id: editorSource.data.id,
          job_type: "process_source",
          status: "pending",
        })
        .select("id")
        .single()
    : { error: editorSource.error, data: null };
  record(
    "Editor kann Jobs starten (insert)",
    !!editorJob.data && !editorJob.error,
    editorJob.error?.message,
  );

  // 6) Editor cannot write knowledge_units / analysis_results
  const kuWrite = await editor.from("knowledge_units").insert({
    project_id: projectA.id,
    source_id: editorSource.data!.id,
    document_id: "00000000-0000-4000-8000-000000000001",
    original_content: "x",
  });
  record(
    "Editor kann Knowledge Units nicht schreiben",
    !!kuWrite.error,
    kuWrite.error?.message,
  );

  const arWrite = await editor.from("analysis_results").insert({
    project_id: projectA.id,
    analysis_run_id: "00000000-0000-4000-8000-000000000002",
    title: "hack",
  });
  record(
    "Editor kann Analysis Results nicht schreiben",
    !!arWrite.error,
    arWrite.error?.message,
  );

  // 7) Owner can manage members
  const ownerToken = await signIn(ownerEmail, password);
  const owner = userClient(ownerToken);
  const memberUpdate = await owner
    .from("project_members")
    .update({ role: "viewer" })
    .eq("project_id", projectA.id)
    .eq("user_id", editorId);
  // restore editor
  await admin
    .from("project_members")
    .update({ role: "editor" })
    .eq("project_id", projectA.id)
    .eq("user_id", editorId);
  record(
    "Owner kann Mitglieder verwalten",
    !memberUpdate.error,
    memberUpdate.error?.message,
  );

  // 8) foreign project_id blocked for viewer insert
  const foreignInsert = await viewer.from("sources").insert({
    project_id: projectB.id,
    name: "nope.txt",
    source_type: "txt",
  });
  record(
    "Zugriff mit fremder project_id wird blockiert",
    !!foreignInsert.error,
    foreignInsert.error?.message,
  );

  // 9) Storage of foreign project not readable
  const foreignDownload = await viewer.storage
    .from("source-originals")
    .download(foreignPath);
  record(
    "Storage-Dateien eines fremden Projekts nicht lesbar",
    !!foreignDownload.error,
    foreignDownload.error?.message,
  );

  // 10) Service role key not in client bundle — static check
  const fs = await import("fs");
  const clientSrc = fs.readFileSync(
    resolve(process.cwd(), "src/lib/supabase/client.ts"),
    "utf8",
  );
  const hasSecretInClient =
    clientSrc.includes("SUPABASE_SECRET") ||
    clientSrc.includes("SERVICE_ROLE") ||
    clientSrc.includes(service.slice(0, 20));
  record(
    "Service-Role-Key erscheint nicht im Client-Modul",
    !hasSecretInClient,
  );

  const failed = results.filter((r) => !r.ok);
  console.log("\nSummary:", results.length - failed.length, "/", results.length, "passed");
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
