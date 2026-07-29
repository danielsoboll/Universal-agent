import { createAdminClient } from "@/lib/supabase/admin";
import { SOURCE_ORIGINALS_BUCKET } from "@/lib/sourceUpload";
import {
  hashContent,
  parseJsonlText,
  parseTxtAsLineRecords,
  type JsonlLineError,
} from "@/lib/ingest/jsonlParse";
import {
  buildPreparedContent,
  buildUnitTitle,
  extractTechnicalFields,
} from "@/lib/ingest/sapFields";

export type IngestSourceResult = {
  ok: boolean;
  error?: string;
  linesRead: number;
  validRecords: number;
  invalidLines: number;
  documentsCreated: number;
  knowledgeUnitsCreated: number;
};

async function downloadSourceText(params: {
  bucket: string;
  path: string;
}): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(params.bucket)
    .download(params.path);
  if (error || !data) {
    throw new Error(error?.message ?? "Datei konnte nicht aus Storage geladen werden.");
  }
  return await data.text();
}

export async function runIngestSourceJob(params: {
  projectId: string;
  sourceId: string;
  jobId: string;
}): Promise<IngestSourceResult> {
  const admin = createAdminClient();
  const { projectId, sourceId, jobId } = params;

  const empty: IngestSourceResult = {
    ok: false,
    linesRead: 0,
    validRecords: 0,
    invalidLines: 0,
    documentsCreated: 0,
    knowledgeUnitsCreated: 0,
  };

  const { data: source, error: sourceError } = await admin
    .from("sources")
    .select(
      "id, project_id, name, source_type, original_filename, storage_bucket, storage_path, metadata",
    )
    .eq("id", sourceId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (sourceError || !source) {
    const message = sourceError?.message ?? "Source nicht gefunden.";
    await admin
      .from("processing_jobs")
      .update({
        status: "failed",
        error: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    return { ...empty, error: message };
  }

  if (!source.storage_path) {
    const message = "Source hat keinen storage_path.";
    await admin
      .from("processing_jobs")
      .update({
        status: "failed",
        error: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    await admin
      .from("sources")
      .update({ processing_status: "failed", processing_error: message })
      .eq("id", sourceId);
    return { ...empty, error: message };
  }

  await admin
    .from("processing_jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", jobId);

  await admin
    .from("sources")
    .update({
      processing_status: "extracting",
      processing_error: null,
    })
    .eq("id", sourceId)
    .eq("project_id", projectId);

  try {
    const bucket = source.storage_bucket || SOURCE_ORIGINALS_BUCKET;
    const text = await downloadSourceText({
      bucket,
      path: source.storage_path,
    });

    const sourceType = source.source_type;
    const parsed =
      sourceType === "txt"
        ? parseTxtAsLineRecords(text)
        : sourceType === "jsonl" ||
            (source.original_filename ?? "").toLowerCase().endsWith(".jsonl")
          ? parseJsonlText(text)
          : null;

    if (!parsed) {
      const message = `Kein Parser für source_type=${sourceType}. Unterstützt: jsonl, txt.`;
      await admin
        .from("processing_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          progress_current: 1,
          progress_total: 1,
          result: { skipped: true, reason: message },
        })
        .eq("id", jobId);
      await admin
        .from("sources")
        .update({
          processing_status: "uploaded",
          processing_error: message,
          metadata: {
            ...(typeof source.metadata === "object" && source.metadata
              ? source.metadata
              : {}),
            ingest: { skipped: true, reason: message },
          },
        })
        .eq("id", sourceId);
      return { ...empty, ok: true, error: message };
    }

    const title =
      source.original_filename || source.name || `Source ${source.id}`;

    const { data: document, error: documentError } = await admin
      .from("documents")
      .insert({
        project_id: projectId,
        source_id: sourceId,
        title,
        original_content: text,
        normalized_content: null,
        metadata: {
          source_type: sourceType,
          lines_read: parsed.linesRead,
          valid_records: parsed.records.length,
          invalid_lines: parsed.errors.length,
        },
      })
      .select("id")
      .single();

    if (documentError || !document) {
      throw new Error(
        documentError?.message ?? "Dokument konnte nicht angelegt werden.",
      );
    }

    const unitRows = parsed.records.map((record) => {
      const fields = extractTechnicalFields(record.value);
      const prepared = buildPreparedContent(fields, record.raw);
      const contentHash = hashContent(record.raw);
      return {
        project_id: projectId,
        source_id: sourceId,
        document_id: document.id,
        unit_type: sourceType === "txt" ? "text_line" : "jsonl_record",
        title: buildUnitTitle(fields, record.lineNumber),
        original_content: record.raw,
        prepared_content: prepared,
        search_text: prepared,
        metadata: {
          technical_fields: fields,
          parsed_value:
            record.value && typeof record.value === "object"
              ? record.value
              : { value: record.value },
        },
        source_location: {
          line_number: record.lineNumber,
          source_id: sourceId,
          storage_path: source.storage_path,
        },
        processing_status: "ready" as const,
        content_hash: contentHash,
      };
    });

    let knowledgeUnitsCreated = 0;
    const chunkSize = 100;
    for (let i = 0; i < unitRows.length; i += chunkSize) {
      const chunk = unitRows.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;
      const { error: kuError } = await admin.from("knowledge_units").insert(chunk);
      if (kuError) {
        throw new Error(kuError.message);
      }
      knowledgeUnitsCreated += chunk.length;
    }

    const lineErrors: JsonlLineError[] = parsed.errors;
    const ingestMeta = {
      lines_read: parsed.linesRead,
      valid_records: parsed.records.length,
      invalid_lines: lineErrors.length,
      documents_created: 1,
      knowledge_units_created: knowledgeUnitsCreated,
      line_errors: lineErrors.slice(0, 50).map((e) => ({
        line_number: e.lineNumber,
        error: e.error,
        raw_preview: e.raw.slice(0, 200),
      })),
      completed_at: new Date().toISOString(),
    };

    await admin
      .from("sources")
      .update({
        processing_status: "ready",
        processing_error:
          lineErrors.length > 0
            ? `${lineErrors.length} fehlerhafte Zeile(n) — gültige Datensätze wurden trotzdem gespeichert.`
            : null,
        metadata: {
          ...(typeof source.metadata === "object" && source.metadata
            ? source.metadata
            : {}),
          ingest: ingestMeta,
        },
      })
      .eq("id", sourceId)
      .eq("project_id", projectId);

    await admin
      .from("processing_jobs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        progress_current: parsed.records.length,
        progress_total: Math.max(parsed.linesRead, 1),
        result: ingestMeta,
        error: null,
      })
      .eq("id", jobId);

    console.info("[ingest] completed", {
      projectId,
      sourceId,
      jobId,
      linesRead: parsed.linesRead,
      valid: parsed.records.length,
      invalid: lineErrors.length,
      units: knowledgeUnitsCreated,
    });

    return {
      ok: true,
      linesRead: parsed.linesRead,
      validRecords: parsed.records.length,
      invalidLines: lineErrors.length,
      documentsCreated: 1,
      knowledgeUnitsCreated,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Ingest fehlgeschlagen.";
    console.error("[ingest] failed", {
      projectId,
      sourceId,
      jobId,
      message,
    });
    await admin
      .from("processing_jobs")
      .update({
        status: "failed",
        error: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    await admin
      .from("sources")
      .update({
        processing_status: "failed",
        processing_error: message,
      })
      .eq("id", sourceId)
      .eq("project_id", projectId);
    return { ...empty, error: message };
  }
}
