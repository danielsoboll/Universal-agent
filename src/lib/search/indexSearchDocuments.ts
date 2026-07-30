import {
  materializeSearchDocument,
  parseSearchDocumentsJsonl,
  searchDocumentsToJsonl,
  type SearchDocumentDraft,
} from "@/lib/search/buildSearchDocuments";
import { searchDocumentSchema, type SearchDocument } from "@/lib/search/searchDocumentSchema";
import type { ZodError } from "zod";

export type IndexSearchDocumentsResult = {
  documents: SearchDocument[];
  created: number;
  updated: number;
  skipped_unchanged: number;
  validation_errors: Array<{
    source_key?: string;
    search_document_id?: string;
    message: string;
    issues?: string[];
  }>;
};

function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/**
 * Merge drafts into an existing SearchDocument set (idempotent by content_hash).
 */
export function indexSearchDocuments(params: {
  drafts: SearchDocumentDraft[];
  existingJsonl?: string;
  now?: string;
}): IndexSearchDocumentsResult {
  const existing = parseSearchDocumentsJsonl(params.existingJsonl ?? "");
  const byId = new Map(existing);
  const validation_errors: IndexSearchDocumentsResult["validation_errors"] = [];

  let created = 0;
  let updated = 0;
  let skipped_unchanged = 0;

  for (const draft of params.drafts) {
    try {
      const idProbe = materializeSearchDocument({
        draft,
        existing: null,
        now: params.now,
      }).document.search_document_id;
      const prior = byId.get(idProbe) ?? null;
      const { document, unchanged } = materializeSearchDocument({
        draft,
        existing: prior,
        now: params.now,
      });

      const checked = searchDocumentSchema.safeParse(document);
      if (!checked.success) {
        validation_errors.push({
          source_key: draft.source_key,
          search_document_id: idProbe,
          message: "SearchDocument-Validierung fehlgeschlagen",
          issues: formatZodIssues(checked.error),
        });
        continue;
      }

      if (unchanged) {
        skipped_unchanged += 1;
        byId.set(checked.data.search_document_id, checked.data);
        continue;
      }

      if (prior) updated += 1;
      else created += 1;
      byId.set(checked.data.search_document_id, checked.data);
    } catch (error) {
      validation_errors.push({
        source_key: draft.source_key,
        message:
          error instanceof Error ? error.message : "Unbekannter Indexierungsfehler",
      });
    }
  }

  const documents = [...byId.values()].sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );

  return {
    documents,
    created,
    updated,
    skipped_unchanged,
    validation_errors,
  };
}

export { searchDocumentsToJsonl };
