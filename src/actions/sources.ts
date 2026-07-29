"use server";

import { revalidatePath } from "next/cache";
import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function detectSourceType(filename: string, mimeType: string | undefined) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".pdf") || mimeType === "application/pdf") return "pdf";
  if (lower.endsWith(".txt") || mimeType?.startsWith("text/")) return "txt";
  return "unknown";
}

export async function createSourceWithUpload(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const file = formData.get("file");

  if (!projectId) {
    throw new Error("Projekt fehlt.");
  }
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Datei fehlt.");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Nicht angemeldet.");
  }

  const { data: membership } = await supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!membership || !["owner", "editor"].includes(membership.role)) {
    throw new Error("Keine Berechtigung zum Hochladen.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const sourceType = detectSourceType(file.name, file.type);
  const safeName = file.name.replace(/[^\w.\-()+ äöüÄÖÜß]/g, "_");

  const { data: source, error: insertError } = await supabase
    .from("sources")
    .insert({
      project_id: projectId,
      name: file.name,
      source_type: sourceType,
      original_filename: file.name,
      mime_type: file.type || null,
      file_size: file.size,
      checksum,
      processing_status: "uploaded",
    })
    .select("id")
    .single();

  if (insertError) {
    throw new Error(insertError.message);
  }

  const storagePath = `${projectId}/${source.id}/${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("source-originals")
    .upload(storagePath, buffer, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    await supabase.from("sources").delete().eq("id", source.id);
    throw new Error(`Upload fehlgeschlagen: ${uploadError.message}`);
  }

  const { error: updateError } = await supabase
    .from("sources")
    .update({ storage_path: storagePath })
    .eq("id", source.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  revalidatePath(`/projects/${projectId}`);
}

export async function startProcessingJobPlaceholder(
  formData: FormData,
): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const sourceId = String(formData.get("sourceId") ?? "");

  if (!projectId || !sourceId) {
    throw new Error("Projekt oder Quelle fehlt.");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Nicht angemeldet.");
  }

  const { data: membership } = await supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!membership || !["owner", "editor"].includes(membership.role)) {
    throw new Error("Keine Berechtigung zum Starten von Jobs.");
  }

  const { data: job, error } = await supabase
    .from("processing_jobs")
    .insert({
      project_id: projectId,
      source_id: sourceId,
      job_type: "process_source",
      status: "pending",
      progress_current: 0,
      progress_total: 1,
      payload: { placeholder: true, phase: 1 },
    })
    .select("id, status")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  try {
    const admin = createAdminClient();
    await admin
      .from("processing_jobs")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        result: { note: "Phase-1-Platzhalter — keine KI-Verarbeitung" },
      })
      .eq("id", job.id);
  } catch {
    // Secret key missing — job remains pending
  }

  revalidatePath(`/projects/${projectId}`);
}
