/**
 * End-to-end ingest smoke: upload fixtures/sap-sample.jsonl and run ingest.
 * Run: npx tsx scripts/ingest-sap-sample.ts
 */
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { runIngestSourceJob } from "../src/lib/ingest/ingestSource";
import { parseJsonlText } from "../src/lib/ingest/jsonlParse";
import { SOURCE_ORIGINALS_BUCKET, sanitizeFilename } from "../src/lib/sourceUpload";

function loadEnv() {
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

loadEnv();

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const service =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const auth = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const password = "Test-Passwort-Phase1!";
  const editorEmail = "editor.phase1@general-agent.test";
  const ownerEmail = "owner.phase1@general-agent.test";

  const ownerSign = await auth.auth.signInWithPassword({
    email: ownerEmail,
    password,
  });
  if (ownerSign.error || !ownerSign.data.user) {
    throw ownerSign.error ?? new Error("owner login failed");
  }

  const { data: project, error: projectError } = await auth
    .from("projects")
    .insert({
      name: `SAP-INGEST-${Date.now()}`,
      description: "SAP JSONL ingest smoke",
      owner_id: ownerSign.data.user.id,
    })
    .select("id, name")
    .single();
  if (projectError || !project) throw projectError;

  const listed = await admin.auth.admin.listUsers({ perPage: 200 });
  const editor = listed.data.users.find((u) => u.email === editorEmail);
  if (!editor) throw new Error("editor missing");
  await admin.from("project_members").upsert({
    project_id: project.id,
    user_id: editor.id,
    role: "editor",
    is_active: true,
  });

  await auth.auth.signOut();
  const editorSign = await auth.auth.signInWithPassword({
    email: editorEmail,
    password,
  });
  if (!editorSign.data.session) throw new Error("editor login failed");

  const editorClient = createClient(url, anon, {
    global: {
      headers: {
        Authorization: `Bearer ${editorSign.data.session.access_token}`,
      },
    },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const fixturePath = resolve(process.cwd(), "fixtures/sap-sample.jsonl");
  const body = readFileSync(fixturePath, "utf8");
  const localParse = parseJsonlText(body);
  const originalFilename = `sap-sample-${Date.now()}.jsonl`;
  const buffer = Buffer.from(body, "utf8");
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const safeFilename = sanitizeFilename(originalFilename);

  const { data: source, error: insertError } = await editorClient
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
    })
    .select("id")
    .single();
  if (insertError || !source) throw insertError;

  const storagePath = `${project.id}/${source.id}/${safeFilename}`;
  const { error: uploadError } = await editorClient.storage
    .from(SOURCE_ORIGINALS_BUCKET)
    .upload(storagePath, buffer, {
      contentType: "application/x-ndjson",
      upsert: false,
    });
  if (uploadError) throw uploadError;

  await editorClient
    .from("sources")
    .update({
      storage_path: storagePath,
      processing_status: "uploaded",
    })
    .eq("id", source.id);

  const { data: job, error: jobError } = await editorClient
    .from("processing_jobs")
    .insert({
      project_id: project.id,
      source_id: source.id,
      job_type: "ingest_source",
      status: "queued",
      payload: { storage_path: storagePath },
    })
    .select("id")
    .single();
  if (jobError || !job) throw jobError;

  const result = await runIngestSourceJob({
    projectId: project.id,
    sourceId: source.id,
    jobId: job.id,
  });

  const { count: kuCount } = await admin
    .from("knowledge_units")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .eq("source_id", source.id);

  const { data: sourceRow } = await admin
    .from("sources")
    .select("processing_status, metadata")
    .eq("id", source.id)
    .single();

  console.log(
    JSON.stringify(
      {
        projectId: project.id,
        projectName: project.name,
        sourceId: source.id,
        jobId: job.id,
        localParse: {
          linesRead: localParse.linesRead,
          valid: localParse.records.length,
          invalid: localParse.errors.length,
        },
        ingest: result,
        sourceStatus: sourceRow?.processing_status,
        knowledgeUnitsInDb: kuCount,
      },
      null,
      2,
    ),
  );

  if (
    !result.ok ||
    result.validRecords !== 4 ||
    result.invalidLines !== 1 ||
    kuCount !== 4 ||
    sourceRow?.processing_status !== "ready"
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
