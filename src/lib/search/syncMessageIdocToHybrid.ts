/**
 * Upsert message-idoc canonical SearchDocuments into the active index
 * (`indexes/search`). Preserves all non-message-idoc docs. Atomic swap.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveWritablePath } from "@/lib/localData/paths";
import { getLocalDataRoot } from "@/lib/localData/root";
import type { CanonicalObject } from "@/lib/ingest/messageIdocCanonical";
import { draftFromMessageIdocObject } from "@/lib/search/adapters/messageIdocConfig";
import { buildLocalSearchIndex } from "@/lib/search/buildLocalSearchIndex";
import {
  materializeSearchDocument,
  parseSearchDocumentsJsonl,
  searchDocumentsToJsonl,
} from "@/lib/search/buildSearchDocuments";
import {
  embedSearchDocuments,
  embeddingsToJsonl,
  parseEmbeddingsJsonl,
} from "@/lib/search/embedSearchDocuments";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";

function isMessageIdocDoc(d: SearchDocument): boolean {
  return (
    d.source_type === "message_idoc_config" ||
    d.knowledge_unit_type === "message_idoc_object"
  );
}

function loadCanonicalObjects(projectKey: string): CanonicalObject[] {
  const abs = resolveWritablePath(
    projectKey,
    "canonical",
    "message-idoc-config/objects.jsonl",
  );
  if (!existsSync(abs)) return [];
  const out: CanonicalObject[] = [];
  for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CanonicalObject);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function syncMessageIdocToHybrid(params: {
  projectKey: string;
  dryRun?: boolean;
  systemId?: string;
  /** Skip high-volume change-pointer rows (TBD62). */
  skipChangePointers?: boolean;
}): Promise<{
  ok: boolean;
  message: string;
  objects_read: number;
  docs_upserted: number;
  docs_embedded: number;
  hybrid_docs_total: number;
  non_msgidoc_preserved: number;
  zecd_indexed: boolean;
}> {
  const key = params.projectKey.trim() || "P01";
  const now = new Date().toISOString();
  const runId = now.replace(/[:.]/g, "-");
  getLocalDataRoot();

  const objects = loadCanonicalObjects(key).filter((o) => {
    if (!params.skipChangePointers) return true;
    return !(
      o.object_type === "ale_model_assignment" &&
      o.object_id.startsWith("CP|")
    );
  });

  const drafts = objects
    .map((o) =>
      draftFromMessageIdocObject({
        object: o,
        sourceSystem: params.systemId ?? "Q01",
      }),
    )
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

  const batchDocs: SearchDocument[] = [];
  for (const draft of drafts) {
    const { document } = materializeSearchDocument({ draft });
    batchDocs.push(document);
  }

  const activeIndexDir = resolveWritablePath(key, "indexes", "search");
  const activeDocsPath = path.join(activeIndexDir, "search_documents.jsonl");
  const activeEmbPath = resolveWritablePath(
    key,
    "embeddings",
    "search/search_embeddings.jsonl",
  );

  const existingDocs = existsSync(activeDocsPath)
    ? [
        ...parseSearchDocumentsJsonl(readFileSync(activeDocsPath, "utf8")).values(),
      ]
    : [];
  const existingEmbs = existsSync(activeEmbPath)
    ? [...parseEmbeddingsJsonl(readFileSync(activeEmbPath, "utf8")).values()]
    : [];

  const preserved = existingDocs.filter((d) => !isMessageIdocDoc(d));
  const mergedDocs = [...preserved, ...batchDocs];

  const zecd_indexed = batchDocs.some(
    (d) =>
      /ZECD/i.test(d.object_name) ||
      /ZECD/i.test(d.title) ||
      /ZECD/i.test(d.search_text),
  );

  if (params.dryRun) {
    return {
      ok: true,
      message: `Dry-run: ${batchDocs.length} message-idoc docs; preserve ${preserved.length}; total ${mergedDocs.length}`,
      objects_read: objects.length,
      docs_upserted: batchDocs.length,
      docs_embedded: 0,
      hybrid_docs_total: mergedDocs.length,
      non_msgidoc_preserved: preserved.length,
      zecd_indexed,
    };
  }

  if (preserved.length === 0 && existingDocs.length > 0) {
    throw new Error(
      "Abbruch: Active index hätte 0 Non-Message-IDoc-Dokumente nach Filter — Pfad/Filter prüfen.",
    );
  }

  let embedded: Awaited<ReturnType<typeof embedSearchDocuments>> | null = null;
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      embedded = await embedSearchDocuments({
        documents: batchDocs,
        existingJsonl: embeddingsToJsonl(
          existingEmbs.filter((e) =>
            batchDocs.some((d) => d.search_document_id === e.search_document_id),
          ),
        ),
        now,
        replaceCorpus: false,
        batchSize: 24,
      });
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable =
        /rate.?limit|429|Provider-Rate-Limit/i.test(msg) ||
        (e as { retryable?: boolean })?.retryable === true;
      if (!retryable || attempt === maxAttempts) throw e;
      const waitMs = Math.min(90_000, 5_000 * attempt);
      console.warn(
        `[message-idoc-index] embed attempt ${attempt}/${maxAttempts} rate-limited — wait ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  if (!embedded) throw new Error("Embedding fehlgeschlagen");

  const keepIds = new Set(mergedDocs.map((d) => d.search_document_id));
  const embById = new Map<string, (typeof existingEmbs)[number]>();
  for (const e of existingEmbs) {
    if (!keepIds.has(e.search_document_id)) continue;
    const doc = existingDocs.find(
      (d) => d.search_document_id === e.search_document_id,
    );
    if (doc && isMessageIdocDoc(doc)) continue;
    embById.set(e.search_document_id, e);
  }
  for (const e of embedded.records) embById.set(e.search_document_id, e);
  const mergedEmbs = [...embById.values()]
    .filter((e) => keepIds.has(e.search_document_id))
    .sort((a, b) => a.search_document_id.localeCompare(b.search_document_id));

  const candidateDir = resolveWritablePath(
    key,
    "indexes",
    `search-msgidoc-candidate-${runId}`,
  );
  const candidateEmb = resolveWritablePath(
    key,
    "embeddings",
    `search-msgidoc-candidate-${runId}/search_embeddings.jsonl`,
  );

  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(
    path.join(candidateDir, "search_documents.jsonl"),
    searchDocumentsToJsonl(mergedDocs),
    "utf8",
  );

  const localIndex = buildLocalSearchIndex({
    documents: mergedDocs,
    embeddings: mergedEmbs,
    now,
  });
  writeFileSync(
    path.join(candidateDir, "exact_index.json"),
    `${JSON.stringify(localIndex.exact_index)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(candidateDir, "fulltext_index.json"),
    `${JSON.stringify(localIndex.fulltext_index)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(candidateDir, "metadata_index.json"),
    `${JSON.stringify(localIndex.metadata_index, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(candidateDir, "relation_index.json"),
    `${JSON.stringify(localIndex.relation_index, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(candidateDir, "vector_index.jsonl"),
    localIndex.vector_index.length
      ? `${localIndex.vector_index.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
    "utf8",
  );
  writeFileSync(
    path.join(candidateDir, "index_manifest.json"),
    `${JSON.stringify(localIndex.manifest, null, 2)}\n`,
    "utf8",
  );
  mkdirSync(path.dirname(candidateEmb), { recursive: true });
  writeFileSync(candidateEmb, embeddingsToJsonl(mergedEmbs), "utf8");

  // Safety: non-msgidoc count must match
  const candDocs = [
    ...parseSearchDocumentsJsonl(
      readFileSync(path.join(candidateDir, "search_documents.jsonl"), "utf8"),
    ).values(),
  ];
  const candPreserved = candDocs.filter((d) => !isMessageIdocDoc(d));
  if (candPreserved.length !== preserved.length) {
    throw new Error(
      `Message-IDoc sync würde andere Quellen verlieren: before=${preserved.length} after=${candPreserved.length}`,
    );
  }

  const backupDir = resolveWritablePath(
    key,
    "indexes",
    `search-backup-msgidoc-${runId}`,
  );
  const backupEmb = resolveWritablePath(
    key,
    "embeddings",
    `search/search_embeddings.backup-msgidoc-${runId}.jsonl`,
  );
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
  if (existsSync(activeIndexDir)) renameSync(activeIndexDir, backupDir);
  renameSync(candidateDir, activeIndexDir);
  if (existsSync(backupEmb)) rmSync(backupEmb, { force: true });
  if (existsSync(activeEmbPath)) renameSync(activeEmbPath, backupEmb);
  renameSync(candidateEmb, activeEmbPath);

  // Remove mistaken indexes/hybrid write from earlier wrong path (safe cleanup)
  const wrongHybrid = resolveWritablePath(
    key,
    "indexes",
    "hybrid/search_documents.jsonl",
  );
  if (existsSync(wrongHybrid)) {
    try {
      rmSync(wrongHybrid, { force: true });
    } catch {
      /* ignore */
    }
  }

  ensureWritableDir(key, "logs", "message-idoc-config");
  writeGeneratedText(
    key,
    "logs",
    "message-idoc-config/index-sync.json",
    `${JSON.stringify(
      {
        synced_at: now,
        objects_read: objects.length,
        docs_upserted: batchDocs.length,
        docs_embedded: embedded.created,
        embeddings_skipped_unchanged: embedded.skipped_unchanged,
        hybrid_docs_total: mergedDocs.length,
        non_msgidoc_preserved: preserved.length,
        zecd_indexed,
        active_index: "indexes/search",
        backup_index: `indexes/search-backup-msgidoc-${runId}`,
      },
      null,
      2,
    )}\n`,
  );

  return {
    ok: true,
    message: `Message-IDoc index sync: ${batchDocs.length} docs upserted, preserved=${preserved.length}, total=${mergedDocs.length}`,
    objects_read: objects.length,
    docs_upserted: batchDocs.length,
    docs_embedded: embedded.created,
    hybrid_docs_total: mergedDocs.length,
    non_msgidoc_preserved: preserved.length,
    zecd_indexed,
  };
}
