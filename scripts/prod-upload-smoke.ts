/**
 * Production upload smoke test against linked Supabase.
 * Run: npx tsx scripts/prod-upload-smoke.ts
 */
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import {
  SOURCE_ORIGINALS_BUCKET,
  sanitizeFilename,
} from "../src/lib/sourceUpload";

function loadEnv() {
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const service =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  if (!url || !anon || !service) {
    throw new Error("Missing Supabase env");
  }

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const password = "Test-Passwort-Phase1!";
  const editorEmail = "editor.phase1@general-agent.test";
  const ownerEmail = "owner.phase1@general-agent.test";

  const auth = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const ownerSign = await auth.auth.signInWithPassword({
    email: ownerEmail,
    password,
  });
  if (ownerSign.error || !ownerSign.data.user) {
    throw new Error(ownerSign.error?.message ?? "owner login failed");
  }

  const { data: project, error: projectError } = await auth
    .from("projects")
    .insert({
      name: `UPLOAD-SMOKE-${Date.now()}`,
      description: "Production upload smoke",
      owner_id: ownerSign.data.user.id,
    })
    .select("id, name")
    .single();
  if (projectError || !project) throw projectError;

  const listed = await admin.auth.admin.listUsers({ perPage: 200 });
  const editorUser = listed.data.users.find((u) => u.email === editorEmail);
  if (!editorUser) throw new Error("editor user missing");
  await admin.from("project_members").upsert({
    project_id: project.id,
    user_id: editorUser.id,
    role: "editor",
    is_active: true,
  });

  await auth.auth.signOut();
  const editorSign = await auth.auth.signInWithPassword({
    email: editorEmail,
    password,
  });
  if (editorSign.error || !editorSign.data.session) {
    throw new Error(editorSign.error?.message ?? "editor login failed");
  }

  const editor = createClient(url, anon, {
    global: {
      headers: {
        Authorization: `Bearer ${editorSign.data.session.access_token}`,
      },
    },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const originalFilename = `smoke-${Date.now()}.jsonl`;
  const body =
    '{"id":1,"text":"erste zeile"}\n{"id":2,"text":"zweite zeile"}\n';
  const tmp = resolve(process.cwd(), originalFilename);
  writeFileSync(tmp, body, "utf8");
  const buffer = Buffer.from(body, "utf8");
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const safeFilename = sanitizeFilename(originalFilename);

  try {
    const { data: source, error: insertError } = await editor
      .from("sources")
      .insert({
        project_id: project.id,
        name: originalFilename,
        source_type: "jsonl",
        original_filename: originalFilename,
        mime_type: "application/x-ndjson",
        file_size: buffer.length,
        checksum,
        storage_bucket: SOURCE_ORIGINALS_BUCKET,
        processing_status: "uploading",
        metadata: {
          original_filename: originalFilename,
          safe_filename: safeFilename,
        },
      })
      .select("id")
      .single();
    if (insertError || !source) throw insertError;

    const storagePath = `${project.id}/${source.id}/${safeFilename}`;
    const { error: uploadError } = await editor.storage
      .from(SOURCE_ORIGINALS_BUCKET)
      .upload(storagePath, buffer, {
        contentType: "application/x-ndjson",
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { error: updateError } = await editor
      .from("sources")
      .update({
        storage_path: storagePath,
        processing_status: "uploaded",
      })
      .eq("id", source.id);
    if (updateError) throw updateError;

    const { data: job, error: jobError } = await editor
      .from("processing_jobs")
      .insert({
        project_id: project.id,
        source_id: source.id,
        job_type: "ingest_source",
        status: "queued",
        payload: { storage_path: storagePath },
      })
      .select("id, status, job_type")
      .single();
    if (jobError || !job) throw jobError;

    const { data: stored } = await admin.storage
      .from(SOURCE_ORIGINALS_BUCKET)
      .download(storagePath);
    const storedText = stored ? await stored.text() : "";

    const { data: sourceRow } = await admin
      .from("sources")
      .select(
        "id, original_filename, source_type, file_size, storage_path, storage_bucket, processing_status",
      )
      .eq("id", source.id)
      .single();

    console.log(
      JSON.stringify(
        {
          projectId: project.id,
          projectName: project.name,
          source: sourceRow,
          job,
          storagePath,
          storedBytes: storedText.length,
          storedMatches: storedText === body,
          pathMatches: storagePath === `${project.id}/${source.id}/${safeFilename}`,
        },
        null,
        2,
      ),
    );

    if (
      sourceRow?.processing_status !== "uploaded" ||
      job.status !== "queued" ||
      job.job_type !== "ingest_source" ||
      storedText !== body
    ) {
      process.exitCode = 1;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
