/**
 * Incremental class-analysis → hybrid search index sync.
 *
 * - Only complete unit_analyses
 * - Skip unchanged source_key + content_hash
 * - Batch upsert of class SearchDocuments + embeddings
 * - Preserve all non-class hybrid entries
 * - Atomic promote via candidate → active rename
 * - Never touches raw/, never stops class analysis
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { parseUnitAnalysesJsonl } from "@/lib/analysis/analyzeCodeUnits";
import type { UnitAnalysisRecord } from "@/lib/analysis/unitAnalysisSchema";
import {
  appendLogLine,
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveWritablePath } from "@/lib/localData/paths";
import { getLocalDataRoot } from "@/lib/localData/root";
import { isClassHybridDocument } from "@/lib/rebuild/wipeDerived";
import {
  draftFromCodeUnitAnalysis,
  type CodeUnitRef,
} from "@/lib/search/adapters/codeUnitAnalysis";
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
  type SearchEmbeddingRecord,
} from "@/lib/search/embedSearchDocuments";
import { searchDocumentSchema, type SearchDocument } from "@/lib/search/searchDocumentSchema";

export const CLASS_INDEX_SYNC_VERSION = "class-index-sync-v1";

export type ClassIndexSyncCheckpoint = {
  version: typeof CLASS_INDEX_SYNC_VERSION;
  project_key: string;
  updated_at: string;
  active_index_path: string;
  active_embeddings_path: string;
  counts: {
    analyses_complete: number;
    analyses_incomplete: number;
    class_docs_in_hybrid: number;
    class_embeddings_in_hybrid: number;
    hybrid_documents_total: number;
    hybrid_embeddings_total: number;
    non_class_documents: number;
    pending_new_or_changed: number;
  };
  last_run_id: string | null;
  last_synced_source_key: string | null;
  last_synced_content_hash: string | null;
  last_batch: {
    created: number;
    updated: number;
    skipped_unchanged: number;
    embeddings_created: number;
    embeddings_skipped: number;
    promoted: boolean;
  } | null;
  runs: Array<{
    run_id: string;
    at: string;
    batch_size: number;
    created: number;
    updated: number;
    skipped: number;
    embeddings_created: number;
    promoted: boolean;
    last_source_key: string | null;
  }>;
};

export type ClassIndexSyncResult = {
  ok: boolean;
  run_id: string;
  dry_run: boolean;
  promoted: boolean;
  message: string;
  candidate_index_path: string;
  active_index_path: string;
  batch: {
    requested: number;
    created: number;
    updated: number;
    skipped_unchanged: number;
    embeddings_created: number;
    embeddings_skipped: number;
    source_keys: string[];
  };
  counts_before: ClassIndexSyncCheckpoint["counts"];
  counts_after: ClassIndexSyncCheckpoint["counts"];
  validation: {
    non_class_preserved: boolean;
    non_class_before: number;
    non_class_after: number;
    schema_ok: boolean;
    rebuild_cvbap_in_batch: boolean;
    rebuild_cvbap_in_result: boolean;
  };
  checkpoint_path: string;
  input_tokens: number;
  estimated_cost: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Full, searchable unit analysis — not a stub. */
export function isCompleteUnitAnalysis(
  a: UnitAnalysisRecord | Record<string, unknown>,
): boolean {
  const ts = String(a.technical_summary ?? "").trim();
  const facts = Array.isArray(a.facts) ? a.facts : [];
  const confidence =
    typeof a.confidence === "number" ? a.confidence : Number(a.confidence);
  const source_key = String(a.source_key ?? "").trim();
  const class_name = String(
    (a as { class_name?: string }).class_name ?? "",
  ).trim();
  const method_name = String(
    (a as { method_name?: string }).method_name ?? "",
  ).trim();
  const content_hash = String(a.content_hash ?? "").trim();
  return (
    source_key.length > 0 &&
    class_name.length > 0 &&
    method_name.length > 0 &&
    ts.length >= 20 &&
    facts.length > 0 &&
    Number.isFinite(confidence) &&
    confidence > 0 &&
    content_hash.length > 0
  );
}

function parseCodeUnitRefs(text: string): Map<string, CodeUnitRef> {
  const map = new Map<string, CodeUnitRef>();
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(value.record_type ?? "code_unit") !== "code_unit") continue;
    const source_key = String(value.source_key ?? "").trim();
    if (!source_key) continue;
    map.set(source_key, {
      source_key,
      system_id:
        typeof value.system_id === "string" ? value.system_id : undefined,
      object_type:
        typeof value.object_type === "string" ? value.object_type : undefined,
      object_name:
        typeof value.object_name === "string" ? value.object_name : undefined,
      unit_type:
        typeof value.unit_type === "string" ? value.unit_type : undefined,
      unit_name:
        typeof value.unit_name === "string" ? value.unit_name : undefined,
      include_name:
        typeof value.include_name === "string" ? value.include_name : undefined,
      language: typeof value.language === "string" ? value.language : undefined,
      line_count:
        typeof value.line_count === "number" ? value.line_count : undefined,
    });
  }
  return map;
}

function loadDocs(abs: string): SearchDocument[] {
  if (!existsSync(abs)) return [];
  return [...parseSearchDocumentsJsonl(readFileSync(abs, "utf8")).values()];
}

function loadEmbs(abs: string): SearchEmbeddingRecord[] {
  if (!existsSync(abs)) return [];
  return [...parseEmbeddingsJsonl(readFileSync(abs, "utf8")).values()];
}

function countByClass(docs: SearchDocument[]): {
  classDocs: SearchDocument[];
  nonClassDocs: SearchDocument[];
} {
  const classDocs: SearchDocument[] = [];
  const nonClassDocs: SearchDocument[] = [];
  for (const d of docs) {
    if (isClassHybridDocument(d)) classDocs.push(d);
    else nonClassDocs.push(d);
  }
  return { classDocs, nonClassDocs };
}

export function computeClassIndexSyncCounts(params: {
  analyses: Map<string, UnitAnalysisRecord>;
  hybridDocs: SearchDocument[];
  hybridEmbs: SearchEmbeddingRecord[];
  pending: number;
}): ClassIndexSyncCheckpoint["counts"] {
  const complete = [...params.analyses.values()].filter(isCompleteUnitAnalysis);
  const incomplete = params.analyses.size - complete.length;
  const { classDocs, nonClassDocs } = countByClass(params.hybridDocs);
  const classIds = new Set(classDocs.map((d) => d.search_document_id));
  const classEmbs = params.hybridEmbs.filter((e) =>
    classIds.has(e.search_document_id),
  );
  return {
    analyses_complete: complete.length,
    analyses_incomplete: incomplete,
    class_docs_in_hybrid: classDocs.length,
    class_embeddings_in_hybrid: classEmbs.length,
    hybrid_documents_total: params.hybridDocs.length,
    hybrid_embeddings_total: params.hybridEmbs.length,
    non_class_documents: nonClassDocs.length,
    pending_new_or_changed: params.pending,
  };
}

/**
 * Select complete analyses that are missing from hybrid or have changed content_hash.
 */
export function selectPendingClassAnalyses(params: {
  analyses: Map<string, UnitAnalysisRecord>;
  units: Map<string, CodeUnitRef>;
  hybridClassBySourceKey: Map<string, SearchDocument>;
  batchSize: number;
  prioritize?: string[];
}): {
  pendingAll: UnitAnalysisRecord[];
  batch: UnitAnalysisRecord[];
  skippedUnchanged: number;
} {
  const complete = [...params.analyses.values()]
    .filter(isCompleteUnitAnalysis)
    .sort((a, b) => a.source_key.localeCompare(b.source_key));

  const pending: UnitAnalysisRecord[] = [];
  let skippedUnchanged = 0;

  for (const analysis of complete) {
    const draft = draftFromCodeUnitAnalysis({
      analysis,
      unit: params.units.get(analysis.source_key) ?? null,
    });
    const existing = params.hybridClassBySourceKey.get(analysis.source_key);
    const { document, unchanged } = materializeSearchDocument({
      draft,
      existing: existing ?? null,
    });
    // Also treat as unchanged if content_hash matches existing hybrid doc
    if (
      existing &&
      (unchanged || existing.content_hash === document.content_hash)
    ) {
      skippedUnchanged += 1;
      continue;
    }
    pending.push(analysis);
  }

  const prioritize = (params.prioritize ?? [])
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  const ranked = [...pending].sort((a, b) => {
    const score = (x: UnitAnalysisRecord) => {
      const blob = `${x.source_key} ${x.class_name} ${x.method_name}`.toUpperCase();
      let s = 0;
      for (let i = 0; i < prioritize.length; i++) {
        const p = prioritize[i]!;
        if (blob.includes(p)) s += (prioritize.length - i) * 100;
      }
      // abapGit last — usually not business-relevant for customer questions
      if (blob.includes("ABAPGIT")) s -= 1000;
      return s;
    };
    const ds = score(b) - score(a);
    if (ds !== 0) return ds;
    return a.source_key.localeCompare(b.source_key);
  });

  return {
    pendingAll: pending,
    batch: ranked.slice(0, Math.max(0, params.batchSize)),
    skippedUnchanged,
  };
}

function writeIndexArtifacts(params: {
  indexDirAbs: string;
  documents: SearchDocument[];
  embeddings: SearchEmbeddingRecord[];
  now: string;
}): void {
  mkdirSync(params.indexDirAbs, { recursive: true });
  writeFileSync(
    path.join(params.indexDirAbs, "search_documents.jsonl"),
    searchDocumentsToJsonl(params.documents),
    "utf8",
  );

  const localIndex = buildLocalSearchIndex({
    documents: params.documents,
    embeddings: params.embeddings,
    now: params.now,
  });

  writeFileSync(
    path.join(params.indexDirAbs, "exact_index.json"),
    `${JSON.stringify(localIndex.exact_index)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(params.indexDirAbs, "fulltext_index.json"),
    `${JSON.stringify(localIndex.fulltext_index)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(params.indexDirAbs, "metadata_index.json"),
    `${JSON.stringify(localIndex.metadata_index, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(params.indexDirAbs, "relation_index.json"),
    `${JSON.stringify(localIndex.relation_index, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(params.indexDirAbs, "vector_index.jsonl"),
    localIndex.vector_index.length
      ? `${localIndex.vector_index.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
    "utf8",
  );
  writeFileSync(
    path.join(params.indexDirAbs, "index_manifest.json"),
    `${JSON.stringify(localIndex.manifest, null, 2)}\n`,
    "utf8",
  );
}

function atomicSwapDir(params: {
  candidateDir: string;
  activeDir: string;
  backupDir: string;
}): void {
  if (existsSync(params.backupDir)) {
    rmSync(params.backupDir, { recursive: true, force: true });
  }
  if (existsSync(params.activeDir)) {
    renameSync(params.activeDir, params.backupDir);
  }
  renameSync(params.candidateDir, params.activeDir);
}

function atomicSwapFile(params: {
  candidateFile: string;
  activeFile: string;
  backupFile: string;
}): void {
  mkdirSync(path.dirname(params.activeFile), { recursive: true });
  if (existsSync(params.backupFile)) rmSync(params.backupFile, { force: true });
  if (existsSync(params.activeFile)) {
    renameSync(params.activeFile, params.backupFile);
  }
  renameSync(params.candidateFile, params.activeFile);
}

function checkpointPath(projectKey: string): string {
  return resolveWritablePath(
    projectKey,
    "logs",
    "class-index-sync/checkpoint.json",
  );
}

export function loadClassIndexSyncCheckpoint(
  projectKey: string,
): ClassIndexSyncCheckpoint | null {
  const p = checkpointPath(projectKey);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ClassIndexSyncCheckpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(
  projectKey: string,
  cp: ClassIndexSyncCheckpoint,
): string {
  ensureWritableDir(projectKey, "logs", "class-index-sync");
  return writeGeneratedText(
    projectKey,
    "logs",
    "class-index-sync/checkpoint.json",
    `${JSON.stringify(cp, null, 2)}\n`,
  );
}

export async function syncClassAnalysesToHybrid(params: {
  projectKey: string;
  batchSize?: number;
  dryRun?: boolean;
  prioritize?: string[];
  systemId?: string;
}): Promise<ClassIndexSyncResult> {
  const projectKey = params.projectKey.trim();
  const batchSize = params.batchSize ?? 250;
  const dryRun = params.dryRun === true;
  const now = nowIso();
  const id = runId();
  const root = path.join(getLocalDataRoot(), projectKey);

  const analysesPath = resolveWritablePath(
    projectKey,
    "analyses",
    "classes/unit_analyses.jsonl",
  );
  const unitsPath = resolveWritablePath(
    projectKey,
    "canonical",
    "classes/code_units.jsonl",
  );
  const activeIndexRel = "search";
  const activeIndexDir = resolveWritablePath(
    projectKey,
    "indexes",
    activeIndexRel,
  );
  const activeDocsPath = path.join(activeIndexDir, "search_documents.jsonl");
  const activeEmbPath = resolveWritablePath(
    projectKey,
    "embeddings",
    "search/search_embeddings.jsonl",
  );

  if (!existsSync(analysesPath)) {
    throw new Error(`unit_analyses fehlen: ${analysesPath}`);
  }
  if (!existsSync(unitsPath)) {
    throw new Error(`code_units fehlen: ${unitsPath}`);
  }

  const analyses = parseUnitAnalysesJsonl(readFileSync(analysesPath, "utf8"));
  const units = parseCodeUnitRefs(readFileSync(unitsPath, "utf8"));
  const hybridDocs = loadDocs(activeDocsPath);
  const hybridEmbs = loadEmbs(activeEmbPath);
  const { classDocs, nonClassDocs } = countByClass(hybridDocs);

  const hybridClassBySourceKey = new Map<string, SearchDocument>();
  for (const d of classDocs) {
    if (d.source_key) hybridClassBySourceKey.set(d.source_key, d);
  }

  const { pendingAll, batch, skippedUnchanged } = selectPendingClassAnalyses({
    analyses,
    units,
    hybridClassBySourceKey,
    batchSize,
    prioritize: params.prioritize,
  });

  const countsBefore = computeClassIndexSyncCounts({
    analyses,
    hybridDocs,
    hybridEmbs,
    pending: pendingAll.length,
  });

  if (batch.length === 0) {
    const cp: ClassIndexSyncCheckpoint = {
      version: CLASS_INDEX_SYNC_VERSION,
      project_key: projectKey,
      updated_at: now,
      active_index_path: `indexes/${activeIndexRel}`,
      active_embeddings_path: "embeddings/search/search_embeddings.jsonl",
      counts: countsBefore,
      last_run_id: id,
      last_synced_source_key:
        loadClassIndexSyncCheckpoint(projectKey)?.last_synced_source_key ??
        null,
      last_synced_content_hash:
        loadClassIndexSyncCheckpoint(projectKey)?.last_synced_content_hash ??
        null,
      last_batch: {
        created: 0,
        updated: 0,
        skipped_unchanged: skippedUnchanged,
        embeddings_created: 0,
        embeddings_skipped: 0,
        promoted: false,
      },
      runs: [
        ...(loadClassIndexSyncCheckpoint(projectKey)?.runs ?? []).slice(-40),
        {
          run_id: id,
          at: now,
          batch_size: batchSize,
          created: 0,
          updated: 0,
          skipped: skippedUnchanged,
          embeddings_created: 0,
          promoted: false,
          last_source_key: null,
        },
      ],
    };
    const checkpoint_path = saveCheckpoint(projectKey, cp);
    return {
      ok: true,
      run_id: id,
      dry_run: dryRun,
      promoted: false,
      message: "Nichts zu syncen — alle vollständigen Analysen bereits indexiert.",
      candidate_index_path: "",
      active_index_path: `indexes/${activeIndexRel}`,
      batch: {
        requested: batchSize,
        created: 0,
        updated: 0,
        skipped_unchanged: skippedUnchanged,
        embeddings_created: 0,
        embeddings_skipped: 0,
        source_keys: [],
      },
      counts_before: countsBefore,
      counts_after: countsBefore,
      validation: {
        non_class_preserved: true,
        non_class_before: nonClassDocs.length,
        non_class_after: nonClassDocs.length,
        schema_ok: true,
        rebuild_cvbap_in_batch: false,
        rebuild_cvbap_in_result: classDocs.some(
          (d) =>
            String(d.object_name ?? "").toUpperCase().includes("COPYROUTINE_ZLNP") &&
            String(d.subobject_name ?? "").toUpperCase().includes("REBUILD_CVBAP"),
        ),
      },
      checkpoint_path,
      input_tokens: 0,
      estimated_cost: 0,
    };
  }

  // Materialize batch docs
  let created = 0;
  let updated = 0;
  const batchDocs: SearchDocument[] = [];
  for (const analysis of batch) {
    const draft = draftFromCodeUnitAnalysis({
      analysis,
      unit: units.get(analysis.source_key) ?? null,
      sourceSystem: params.systemId,
    });
    const existing = hybridClassBySourceKey.get(analysis.source_key) ?? null;
    const { document } = materializeSearchDocument({
      draft,
      existing,
      now,
    });
    const checked = searchDocumentSchema.safeParse(document);
    if (!checked.success) {
      throw new Error(
        `SearchDocument ungültig für ${analysis.source_key}: ${checked.error.message}`,
      );
    }
    if (existing) updated += 1;
    else created += 1;
    batchDocs.push(checked.data);
  }

  // Merge: non-class + existing class not in batch + batch upserts
  const batchIds = new Set(batchDocs.map((d) => d.search_document_id));
  const batchKeys = new Set(batchDocs.map((d) => d.source_key));
  const keptClass = classDocs.filter(
    (d) => !batchIds.has(d.search_document_id) && !batchKeys.has(d.source_key),
  );
  const mergedDocs = [...nonClassDocs, ...keptClass, ...batchDocs].sort((a, b) =>
    a.search_document_id.localeCompare(b.search_document_id),
  );

  // Embeddings: keep non-batch, embed only batch docs (incremental skip by hash)
  const keepEmbIds = new Set(mergedDocs.map((d) => d.search_document_id));
  const existingEmbForEmbed = hybridEmbs.filter((e) =>
    keepEmbIds.has(e.search_document_id),
  );

  let embeddings_created = 0;
  let embeddings_skipped = 0;
  let input_tokens = 0;
  let estimated_cost = 0;
  let mergedEmbs: SearchEmbeddingRecord[] = existingEmbForEmbed;

  if (!dryRun) {
    const embedded = await embedSearchDocuments({
      documents: batchDocs,
      existingJsonl: embeddingsToJsonl(existingEmbForEmbed),
      batchSize: 64,
      now,
      replaceCorpus: false,
    });
    embeddings_created = embedded.created;
    embeddings_skipped = embedded.skipped_unchanged;
    input_tokens = embedded.input_tokens;
    estimated_cost = embedded.estimated_cost;

    const byId = new Map(existingEmbForEmbed.map((e) => [e.search_document_id, e]));
    for (const rec of embedded.records) {
      byId.set(rec.search_document_id, rec);
    }
    // Drop embeddings for removed class docs (none in incremental keep-all mode)
    mergedEmbs = [...byId.values()]
      .filter((e) => keepEmbIds.has(e.search_document_id))
      .sort((a, b) => a.search_document_id.localeCompare(b.search_document_id));
  } else {
    // Dry-run: pretend embeddings exist for validation structure
    mergedEmbs = existingEmbForEmbed;
  }

  const candidateIndexRel = `search-candidate-${id}`;
  const candidateIndexDir = resolveWritablePath(
    projectKey,
    "indexes",
    candidateIndexRel,
  );
  const candidateEmbRel = `search-candidate-${id}/search_embeddings.jsonl`;
  const candidateEmbPath = resolveWritablePath(
    projectKey,
    "embeddings",
    candidateEmbRel,
  );

  writeIndexArtifacts({
    indexDirAbs: candidateIndexDir,
    documents: mergedDocs,
    embeddings: dryRun ? existingEmbForEmbed : mergedEmbs,
    now,
  });
  mkdirSync(path.dirname(candidateEmbPath), { recursive: true });
  writeFileSync(
    candidateEmbPath,
    embeddingsToJsonl(dryRun ? existingEmbForEmbed : mergedEmbs),
    "utf8",
  );

  // Also refresh staging classes docs (union) for optional tooling
  const stagingClassesPath = resolveWritablePath(
    projectKey,
    "indexes",
    "classes/search_documents.jsonl",
  );
  const stagingExisting = loadDocs(stagingClassesPath);
  const stagingById = new Map(
    stagingExisting.map((d) => [d.search_document_id, d]),
  );
  for (const d of batchDocs) stagingById.set(d.search_document_id, d);
  if (!dryRun) {
    ensureWritableDir(projectKey, "indexes", "classes");
    writeGeneratedText(
      projectKey,
      "indexes",
      "classes/search_documents.jsonl",
      searchDocumentsToJsonl(
        [...stagingById.values()].sort((a, b) =>
          a.source_key.localeCompare(b.source_key),
        ),
      ),
    );
  }

  // Validate candidate
  const candidateDocs = loadDocs(
    path.join(candidateIndexDir, "search_documents.jsonl"),
  );
  const candidateSplit = countByClass(candidateDocs);
  const schema_ok = candidateDocs.every(
    (d) => searchDocumentSchema.safeParse(d).success,
  );
  const non_class_preserved =
    candidateSplit.nonClassDocs.length === nonClassDocs.length &&
    nonClassDocs.every((d) =>
      candidateSplit.nonClassDocs.some(
        (c) => c.search_document_id === d.search_document_id,
      ),
    );

  const rebuildInBatch = batch.some(
    (a) =>
      a.class_name.toUpperCase().includes("COPYROUTINE_ZLNP") &&
      a.method_name.toUpperCase().includes("REBUILD_CVBAP"),
  );
  const rebuildInResult = candidateSplit.classDocs.some(
    (d) =>
      String(d.object_name ?? "").toUpperCase().includes("COPYROUTINE_ZLNP") &&
      String(d.subobject_name ?? "").toUpperCase().includes("REBUILD_CVBAP"),
  );

  if (!schema_ok || !non_class_preserved) {
    throw new Error(
      `Candidate-Validierung fehlgeschlagen: schema_ok=${schema_ok} non_class_preserved=${non_class_preserved} (before=${nonClassDocs.length} after=${candidateSplit.nonClassDocs.length})`,
    );
  }

  let promoted = false;
  if (!dryRun) {
    const backupIndexDir = resolveWritablePath(
      projectKey,
      "indexes",
      `search-backup-${id}`,
    );
    const backupEmbPath = resolveWritablePath(
      projectKey,
      "embeddings",
      `search/search_embeddings.backup-${id}.jsonl`,
    );

    // Promote index dir
    atomicSwapDir({
      candidateDir: candidateIndexDir,
      activeDir: activeIndexDir,
      backupDir: backupIndexDir,
    });

    // Promote embeddings file
    atomicSwapFile({
      candidateFile: candidateEmbPath,
      activeFile: activeEmbPath,
      backupFile: backupEmbPath,
    });

    // Clean empty candidate emb dir if left
    const candEmbDir = path.dirname(candidateEmbPath);
    if (existsSync(candEmbDir) && readdirSync(candEmbDir).length === 0) {
      rmSync(candEmbDir, { recursive: true, force: true });
    }

    promoted = true;
  }

  const afterDocs = dryRun ? candidateDocs : loadDocs(activeDocsPath);
  const afterEmbs = dryRun ? mergedEmbs : loadEmbs(activeEmbPath);
  const remainingPending = Math.max(0, pendingAll.length - batch.length);
  const countsAfter = computeClassIndexSyncCounts({
    analyses,
    hybridDocs: afterDocs,
    hybridEmbs: afterEmbs,
    pending: remainingPending,
  });

  const lastDoc = batchDocs[batchDocs.length - 1]!;
  const prev = loadClassIndexSyncCheckpoint(projectKey);
  const cp: ClassIndexSyncCheckpoint = {
    version: CLASS_INDEX_SYNC_VERSION,
    project_key: projectKey,
    updated_at: now,
    active_index_path: `indexes/${activeIndexRel}`,
    active_embeddings_path: "embeddings/search/search_embeddings.jsonl",
    counts: countsAfter,
    last_run_id: id,
    last_synced_source_key: lastDoc.source_key,
    last_synced_content_hash: lastDoc.content_hash,
    last_batch: {
      created,
      updated,
      skipped_unchanged: skippedUnchanged,
      embeddings_created,
      embeddings_skipped,
      promoted,
    },
    runs: [
      ...(prev?.runs ?? []).slice(-40),
      {
        run_id: id,
        at: now,
        batch_size: batchSize,
        created,
        updated,
        skipped: skippedUnchanged,
        embeddings_created,
        promoted,
        last_source_key: lastDoc.source_key,
      },
    ],
  };
  const checkpoint_path = saveCheckpoint(projectKey, cp);

  appendLogLine(
    projectKey,
    "class-index-sync/sync.log",
    `[${now}] run=${id} dry=${dryRun} promoted=${promoted} batch=${batch.length} created=${created} updated=${updated} emb_new=${embeddings_created} class_docs=${countsAfter.class_docs_in_hybrid} pending=${remainingPending}`,
  );

  // Write run report
  writeGeneratedText(
    projectKey,
    "logs",
    `class-index-sync/run-${id}.json`,
    `${JSON.stringify(
      {
        run_id: id,
        at: now,
        dry_run: dryRun,
        promoted,
        batch_source_keys: batchDocs.map((d) => d.source_key),
        counts_before: countsBefore,
        counts_after: countsAfter,
        validation: {
          non_class_preserved,
          non_class_before: nonClassDocs.length,
          non_class_after: candidateSplit.nonClassDocs.length,
          schema_ok,
          rebuild_cvbap_in_batch: rebuildInBatch,
          rebuild_cvbap_in_result: rebuildInResult,
        },
        root,
      },
      null,
      2,
    )}\n`,
  );

  return {
    ok: true,
    run_id: id,
    dry_run: dryRun,
    promoted,
    message: promoted
      ? `Batch ${batch.length} Klassenmethoden in aktiven Hybrid-Index übernommen.`
      : dryRun
        ? `Dry-Run: Candidate gebaut (${batch.length} Docs), nicht aktiviert.`
        : "Sync ohne Promote.",
    candidate_index_path: dryRun
      ? `indexes/${candidateIndexRel}`
      : promoted
        ? `indexes/${activeIndexRel}`
        : `indexes/${candidateIndexRel}`,
    active_index_path: `indexes/${activeIndexRel}`,
    batch: {
      requested: batchSize,
      created,
      updated,
      skipped_unchanged: skippedUnchanged,
      embeddings_created,
      embeddings_skipped,
      source_keys: batchDocs.map((d) => d.source_key),
    },
    counts_before: countsBefore,
    counts_after: countsAfter,
    validation: {
      non_class_preserved,
      non_class_before: nonClassDocs.length,
      non_class_after: candidateSplit.nonClassDocs.length,
      schema_ok,
      rebuild_cvbap_in_batch: rebuildInBatch,
      rebuild_cvbap_in_result: rebuildInResult,
    },
    checkpoint_path,
    input_tokens,
    estimated_cost,
  };
}

/** Exported for tests — merge without I/O. */
export function mergeClassBatchIntoHybridDocs(params: {
  existingDocs: SearchDocument[];
  batchDocs: SearchDocument[];
}): {
  merged: SearchDocument[];
  nonClassCount: number;
  classCount: number;
} {
  const { classDocs, nonClassDocs } = countByClass(params.existingDocs);
  const batchIds = new Set(params.batchDocs.map((d) => d.search_document_id));
  const batchKeys = new Set(params.batchDocs.map((d) => d.source_key));
  const keptClass = classDocs.filter(
    (d) => !batchIds.has(d.search_document_id) && !batchKeys.has(d.source_key),
  );
  const merged = [...nonClassDocs, ...keptClass, ...params.batchDocs].sort(
    (a, b) => a.search_document_id.localeCompare(b.search_document_id),
  );
  const split = countByClass(merged);
  return {
    merged,
    nonClassCount: split.nonClassDocs.length,
    classCount: split.classDocs.length,
  };
}
