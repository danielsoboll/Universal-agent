/**
 * Upsert Z/Y/ZZ/Append master-field SearchDocuments into the active hybrid index.
 * Preserves control tables, classes, programs and other non-master-field docs.
 *
 *   npm run index:sync-master-fields -- --project P01
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveWritablePath } from "@/lib/localData/paths";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  draftFromMasterFieldDefinition,
  isZOrAppendField,
  type MasterFieldDefinitionInput,
} from "@/lib/search/adapters/masterFieldDefinition";
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

const DOMAINS = ["customers", "materials", "vendors"] as const;

function isMasterFieldDoc(d: SearchDocument): boolean {
  return (
    d.knowledge_unit_type === "master_field" ||
    d.source_type === "master_field_definition"
  );
}

function loadStructureFields(projectKey: string): MasterFieldDefinitionInput[] {
  const root = resolveWritablePath(projectKey, "canonical", "master-data");
  const out: MasterFieldDefinitionInput[] = [];
  if (!existsSync(root)) return out;

  for (const domain of DOMAINS) {
    const domainDir = path.join(root, domain);
    if (!existsSync(domainDir)) continue;
    for (const table of readdirSync(domainDir)) {
      const struct = path.join(domainDir, table, "structure.jsonl");
      if (!existsSync(struct)) continue;
      for (const line of readFileSync(struct, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (String(rec.record_type) !== "master_field_definition") continue;
        const field_name = String(rec.field_name ?? "").trim();
        if (!field_name) continue;
        // Index all Z/Y/Append fields; also standard fields with non-empty description
        // are optional — requirement focuses on Z/Y/ZZ/Append.
        if (
          !isZOrAppendField(field_name) &&
          rec._is_z_field !== true &&
          rec._is_append_include !== true
        ) {
          continue;
        }
        out.push({
          table_name: String(rec.table_name ?? table),
          field_name,
          description: String(rec.description ?? ""),
          field_text: String(rec.description ?? ""),
          data_element: String(rec.data_element ?? ""),
          data_element_text: String(rec.data_element_text ?? ""),
          domain: String(rec.domain ?? ""),
          domain_text: String(rec.domain_text ?? ""),
          data_type: String(rec.data_type ?? ""),
          length: rec.length as number | string | undefined,
          position: typeof rec.position === "number" ? rec.position : undefined,
          system_id: String(rec.system_id ?? ""),
          profile: String(rec.profile ?? ""),
          key: Boolean(rec.key),
          included_in_content: Boolean(rec.included_in_content),
          _is_z_field: Boolean(rec._is_z_field) || isZOrAppendField(field_name),
          _is_append_include: Boolean(rec._is_append_include),
          _source_file: String(rec._source_file ?? ""),
          _canonical_key: String(rec._canonical_key ?? ""),
        });
      }
    }
  }
  return out;
}

export async function syncMasterFieldsToHybrid(params: {
  projectKey: string;
  dryRun?: boolean;
  systemId?: string;
}): Promise<{
  ok: boolean;
  field_candidates: number;
  created: number;
  updated: number;
  skipped: number;
  embeddings_created: number;
  hybrid_total: number;
  master_field_docs: number;
  non_master_preserved: number;
  sample_z_field_indexed: boolean;
  message: string;
}> {
  const projectKey = params.projectKey;
  const now = new Date().toISOString();
  const runId = now.replace(/[:.]/g, "-");
  getLocalDataRoot();

  const fields = loadStructureFields(projectKey);
  const drafts = fields
    .map((f) =>
      draftFromMasterFieldDefinition({
        field: f,
        sourceSystem: params.systemId || f.system_id || "Q01",
      }),
    )
    .filter(Boolean);

  const activeIndexDir = resolveWritablePath(projectKey, "indexes", "search");
  const activeDocsPath = path.join(activeIndexDir, "search_documents.jsonl");
  const activeEmbPath = resolveWritablePath(
    projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
  );

  const existingDocs = existsSync(activeDocsPath)
    ? [...parseSearchDocumentsJsonl(readFileSync(activeDocsPath, "utf8")).values()]
    : [];
  const existingEmbs = existsSync(activeEmbPath)
    ? [...parseEmbeddingsJsonl(readFileSync(activeEmbPath, "utf8")).values()]
    : [];

  const nonMaster = existingDocs.filter((d) => !isMasterFieldDoc(d));
  const existingMaster = existingDocs.filter(isMasterFieldDoc);
  const byId = new Map(existingMaster.map((d) => [d.search_document_id, d]));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const batchDocs: SearchDocument[] = [];

  for (const draft of drafts) {
    if (!draft) continue;
    const prior = [...byId.values()].find((d) => d.source_key === draft.source_key) ?? null;
    const { document, unchanged } = materializeSearchDocument({
      draft,
      existing: prior,
      now,
    });
    if (unchanged && prior) {
      skipped += 1;
      batchDocs.push(prior);
      continue;
    }
    if (prior) updated += 1;
    else created += 1;
    batchDocs.push(document);
    byId.set(document.search_document_id, document);
  }

  // Keep previous master fields not in current scan? Prefer replace-corpus for master fields only.
  const mergedDocs = [...nonMaster, ...batchDocs].sort((a, b) =>
    a.search_document_id.localeCompare(b.search_document_id),
  );

  if (params.dryRun) {
    return {
      ok: true,
      field_candidates: fields.length,
      created,
      updated,
      skipped,
      embeddings_created: 0,
      hybrid_total: mergedDocs.length,
      master_field_docs: batchDocs.length,
      non_master_preserved: nonMaster.length,
      sample_z_field_indexed: batchDocs.some((d) => Boolean(d.metadata?.is_z_field) || /^[ZY]/i.test(String(d.subobject_name || ""))),
      message: "Dry-run — nichts geschrieben.",
    };
  }

  const embedded = await embedSearchDocuments({
    documents: batchDocs,
    existingJsonl: embeddingsToJsonl(
      existingEmbs.filter((e) =>
        batchDocs.some((d) => d.search_document_id === e.search_document_id),
      ),
    ),
    now,
    replaceCorpus: false,
  });

  const keepIds = new Set(mergedDocs.map((d) => d.search_document_id));
  const embById = new Map<string, (typeof existingEmbs)[number]>();
  for (const e of existingEmbs) {
    if (!keepIds.has(e.search_document_id)) continue;
    const doc = existingDocs.find(
      (d) => d.search_document_id === e.search_document_id,
    );
    if (doc && isMasterFieldDoc(doc)) continue;
    embById.set(e.search_document_id, e);
  }
  for (const e of embedded.records) embById.set(e.search_document_id, e);
  const mergedEmbs = [...embById.values()]
    .filter((e) => keepIds.has(e.search_document_id))
    .sort((a, b) => a.search_document_id.localeCompare(b.search_document_id));

  const candidateDir = resolveWritablePath(
    projectKey,
    "indexes",
    `search-mf-candidate-${runId}`,
  );
  const candidateEmb = resolveWritablePath(
    projectKey,
    "embeddings",
    `search-mf-candidate-${runId}/search_embeddings.jsonl`,
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

  // Validate non-master preserved
  const candDocs = [
    ...parseSearchDocumentsJsonl(
      readFileSync(path.join(candidateDir, "search_documents.jsonl"), "utf8"),
    ).values(),
  ];
  const candNonMaster = candDocs.filter((d) => !isMasterFieldDoc(d));
  if (candNonMaster.length !== nonMaster.length) {
    throw new Error(
      `Master-field sync würde Non-Master verlieren: before=${nonMaster.length} after=${candNonMaster.length}`,
    );
  }

  const backupDir = resolveWritablePath(
    projectKey,
    "indexes",
    `search-backup-mf-${runId}`,
  );
  const backupEmb = resolveWritablePath(
    projectKey,
    "embeddings",
    `search/search_embeddings.backup-mf-${runId}.jsonl`,
  );
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
  if (existsSync(activeIndexDir)) renameSync(activeIndexDir, backupDir);
  renameSync(candidateDir, activeIndexDir);
  if (existsSync(backupEmb)) rmSync(backupEmb, { force: true });
  if (existsSync(activeEmbPath)) renameSync(activeEmbPath, backupEmb);
  renameSync(candidateEmb, activeEmbPath);

  ensureWritableDir(projectKey, "logs", "master-field-sync");
  writeGeneratedText(
    projectKey,
    "logs",
    `master-field-sync/run-${runId}.json`,
    `${JSON.stringify(
      {
        at: now,
        field_candidates: fields.length,
        created,
        updated,
        skipped,
        embeddings_created: embedded.created,
        hybrid_total: mergedDocs.length,
        master_field_docs: batchDocs.length,
        sample_z_field_indexed: batchDocs.some((d) => Boolean(d.metadata?.is_z_field) || /^[ZY]/i.test(String(d.subobject_name || ""))),
      },
      null,
      2,
    )}\n`,
  );

  return {
    ok: true,
    field_candidates: fields.length,
    created,
    updated,
    skipped,
    embeddings_created: embedded.created,
    hybrid_total: mergedDocs.length,
    master_field_docs: batchDocs.length,
    non_master_preserved: nonMaster.length,
    sample_z_field_indexed: batchDocs.some((d) => Boolean(d.metadata?.is_z_field) || /^[ZY]/i.test(String(d.subobject_name || ""))),
    message: `Master-Felder synchronisiert: ${batchDocs.length} Felddokumente im Hybrid.`,
  };
}
