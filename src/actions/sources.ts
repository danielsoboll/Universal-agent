"use server";

import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  ALLOWED_SOURCE_EXTENSIONS,
  detectAllowedSourceType,
  formatUploadLimit,
  getAllowedExtension,
  MAX_SOURCE_UPLOAD_BYTES,
  sanitizeFilename,
  SOURCE_ORIGINALS_BUCKET,
} from "@/lib/sourceUpload";

export type CreateSourceState = {
  error: string | null;
  ok: boolean;
  sourceId: string | null;
};

function formatSupabaseError(error: {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}): string {
  const parts = [error.message];
  if (error.code) parts.push(`Code: ${error.code}`);
  if (error.details) parts.push(error.details);
  if (error.hint) parts.push(`Hinweis: ${error.hint}`);
  return parts.join(" · ");
}

async function removeStorageObject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  storagePath: string,
) {
  const { error } = await supabase.storage
    .from(SOURCE_ORIGINALS_BUCKET)
    .remove([storagePath]);
  if (error) {
    console.error("[createSourceWithUpload] storage cleanup failed", {
      storagePath,
      message: error.message,
    });
  }
}

async function removeSourceRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  sourceId: string,
  projectId: string,
) {
  const { error } = await supabase
    .from("sources")
    .delete()
    .eq("id", sourceId)
    .eq("project_id", projectId);
  if (error) {
    console.error("[createSourceWithUpload] source cleanup failed", {
      sourceId,
      projectId,
      message: error.message,
      code: error.code,
    });
  }
}

export async function createSourceWithUpload(
  _prev: CreateSourceState,
  formData: FormData,
): Promise<CreateSourceState> {
  const projectId = String(formData.get("projectId") ?? "").trim();
  const file = formData.get("file");

  if (!projectId) {
    return { error: "Projekt fehlt.", ok: false, sourceId: null };
  }
  if (!(file instanceof File)) {
    return { error: "Bitte eine Datei auswählen.", ok: false, sourceId: null };
  }
  if (file.size === 0) {
    return { error: "Die Datei ist leer.", ok: false, sourceId: null };
  }
  if (file.size > MAX_SOURCE_UPLOAD_BYTES) {
    return {
      error: `Datei zu groß (${formatUploadLimit()} maximal).`,
      ok: false,
      sourceId: null,
    };
  }

  const extension = getAllowedExtension(file.name);
  const sourceType = detectAllowedSourceType(file.name);
  if (!extension || !sourceType) {
    return {
      error: `Dateityp nicht erlaubt. Erlaubt: ${ALLOWED_SOURCE_EXTENSIONS.join(", ")}`,
      ok: false,
      sourceId: null,
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) {
    console.error("[createSourceWithUpload] auth.getUser failed", {
      message: authError.message,
      status: authError.status,
    });
    return {
      error: "Anmeldung konnte nicht geprüft werden. Bitte erneut einloggen.",
      ok: false,
      sourceId: null,
    };
  }

  if (!user) {
    console.error("[createSourceWithUpload] not authenticated");
    return {
      error: "Nicht angemeldet. Bitte einloggen und erneut versuchen.",
      ok: false,
      sourceId: null,
    };
  }

  const { data: membership, error: membershipError } = await supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (membershipError) {
    console.error("[createSourceWithUpload] membership check failed", {
      projectId,
      userId: user.id,
      message: membershipError.message,
      code: membershipError.code,
      details: membershipError.details,
      hint: membershipError.hint,
    });
    return {
      error: `Berechtigung konnte nicht geprüft werden. ${formatSupabaseError(membershipError)}`,
      ok: false,
      sourceId: null,
    };
  }

  if (!membership || !["owner", "editor"].includes(membership.role)) {
    console.error("[createSourceWithUpload] forbidden", {
      projectId,
      userId: user.id,
      role: membership?.role ?? null,
    });
    return {
      error: "Keine Berechtigung zum Hochladen (nur Editor oder Owner).",
      ok: false,
      sourceId: null,
    };
  }

  const originalFilename = file.name;
  const safeFilename = sanitizeFilename(originalFilename);
  const buffer = Buffer.from(await file.arrayBuffer());
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const mimeType = file.type || null;

  console.info("[createSourceWithUpload] start", {
    projectId,
    userId: user.id,
    role: membership.role,
    originalFilename,
    safeFilename,
    sizeBytes: file.size,
    sourceType,
  });

  const { data: source, error: insertError } = await supabase
    .from("sources")
    .insert({
      project_id: projectId,
      name: originalFilename,
      source_type: sourceType,
      original_filename: originalFilename,
      mime_type: mimeType,
      file_size: file.size,
      checksum,
      storage_bucket: SOURCE_ORIGINALS_BUCKET,
      processing_status: "uploading",
      metadata: {
        original_filename: originalFilename,
        safe_filename: safeFilename,
        uploaded_by: user.id,
      },
    })
    .select("id")
    .single();

  if (insertError || !source?.id) {
    console.error("[createSourceWithUpload] source insert failed", {
      projectId,
      userId: user.id,
      message: insertError?.message,
      code: insertError?.code,
      details: insertError?.details,
      hint: insertError?.hint,
    });
    const duplicate =
      insertError?.code === "23505" ||
      insertError?.message?.toLowerCase().includes("duplicate");
    return {
      error: duplicate
        ? "Diese Datei wurde in diesem Projekt bereits hochgeladen (gleicher Inhalt)."
        : `Quelle konnte nicht angelegt werden. ${insertError ? formatSupabaseError(insertError) : "Keine ID."}`,
      ok: false,
      sourceId: null,
    };
  }

  const storagePath = `${projectId}/${source.id}/${safeFilename}`;

  const { error: uploadError } = await supabase.storage
    .from(SOURCE_ORIGINALS_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    console.error("[createSourceWithUpload] storage upload failed", {
      projectId,
      sourceId: source.id,
      storagePath,
      message: uploadError.message,
    });
    await removeSourceRow(supabase, source.id, projectId);
    return {
      error: `Datei-Upload fehlgeschlagen: ${uploadError.message}`,
      ok: false,
      sourceId: null,
    };
  }

  const { error: updateError } = await supabase
    .from("sources")
    .update({
      storage_path: storagePath,
      storage_bucket: SOURCE_ORIGINALS_BUCKET,
      processing_status: "uploaded",
      processing_error: null,
      metadata: {
        original_filename: originalFilename,
        safe_filename: safeFilename,
        uploaded_by: user.id,
        size_bytes: file.size,
        storage_bucket: SOURCE_ORIGINALS_BUCKET,
        storage_path: storagePath,
      },
    })
    .eq("id", source.id)
    .eq("project_id", projectId);

  if (updateError) {
    console.error("[createSourceWithUpload] source update after upload failed", {
      projectId,
      sourceId: source.id,
      storagePath,
      message: updateError.message,
      code: updateError.code,
      details: updateError.details,
      hint: updateError.hint,
    });
    await removeStorageObject(supabase, storagePath);
    await removeSourceRow(supabase, source.id, projectId);
    return {
      error: `Metadaten konnten nicht gespeichert werden. ${formatSupabaseError(updateError)}`,
      ok: false,
      sourceId: null,
    };
  }

  const { data: job, error: jobError } = await supabase
    .from("processing_jobs")
    .insert({
      project_id: projectId,
      source_id: source.id,
      job_type: "ingest_source",
      status: "queued",
      progress_current: 0,
      progress_total: 1,
      payload: {
        source_id: source.id,
        storage_bucket: SOURCE_ORIGINALS_BUCKET,
        storage_path: storagePath,
        original_filename: originalFilename,
      },
    })
    .select("id")
    .single();

  if (jobError || !job?.id) {
    console.error("[createSourceWithUpload] job insert failed", {
      projectId,
      sourceId: source.id,
      storagePath,
      message: jobError?.message,
      code: jobError?.code,
      details: jobError?.details,
      hint: jobError?.hint,
    });
    await removeStorageObject(supabase, storagePath);
    await removeSourceRow(supabase, source.id, projectId);
    return {
      error: `Processing-Job konnte nicht angelegt werden. ${jobError ? formatSupabaseError(jobError) : "Keine Job-ID."}`,
      ok: false,
      sourceId: null,
    };
  }

  console.info("[createSourceWithUpload] success", {
    projectId,
    sourceId: source.id,
    jobId: job.id,
    storagePath,
  });

  // Run ingest server-side immediately (service role writes docs/KUs).
  try {
    const { runIngestSourceJob } = await import("@/lib/ingest/ingestSource");
    const ingestResult = await runIngestSourceJob({
      projectId,
      sourceId: source.id,
      jobId: job.id,
    });
    if (!ingestResult.ok) {
      console.error("[createSourceWithUpload] ingest failed", {
        projectId,
        sourceId: source.id,
        jobId: job.id,
        error: ingestResult.error,
      });
      revalidatePath(`/projects/${projectId}`);
      return {
        error: `Upload ok, Verarbeitung fehlgeschlagen: ${ingestResult.error ?? "unbekannt"}`,
        ok: false,
        sourceId: source.id,
      };
    }
  } catch (error) {
    console.error("[createSourceWithUpload] ingest threw", {
      projectId,
      sourceId: source.id,
      jobId: job.id,
      message: error instanceof Error ? error.message : "unknown",
    });
    revalidatePath(`/projects/${projectId}`);
    return {
      error:
        "Upload ok, Verarbeitung konnte nicht gestartet werden. Bitte Seite neu laden.",
      ok: false,
      sourceId: source.id,
    };
  }

  revalidatePath(`/projects/${projectId}`);
  return { error: null, ok: true, sourceId: source.id };
}
