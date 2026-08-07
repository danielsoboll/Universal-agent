/**
 * Server-process in-memory cache for ask-path search artifacts.
 * Fingerprint = path + mtimeMs + size; unchanged sources → no re-read/parse.
 * Measurement-only notes via askPerf when active.
 */
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import type { LocalProject } from "@/lib/localAuth/types";
import { parseSearchDocumentsJsonl } from "@/lib/search/buildSearchDocuments";
import type { LocalSearchIndex } from "@/lib/search/buildLocalSearchIndex";
import {
  parseEmbeddingsJsonl,
  type SearchEmbeddingRecord,
} from "@/lib/search/embedSearchDocuments";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  askPerfBegin,
  askPerfEnd,
  askPerfNote,
  askPerfSetIndexLoaded,
  askPerfTrackedReadFile,
} from "@/lib/knowledge/askPerf";
import {
  isPortableIndexReady,
  loadPortableEvidenceMaps,
  loadPortableManifest,
} from "@/lib/portableIndex/indexLoader";

export type FileStamp = {
  path: string;
  mtimeMs: number;
  size: number;
};

export type ProjectSearchBundle = {
  cache_key: string;
  fingerprint: string;
  data_root: string;
  index_dir: string;
  docs_path: string;
  documents: SearchDocument[];
  documentsById: Map<string, SearchDocument>;
  index: LocalSearchIndex;
  /** Embeddings file exists and is non-empty (stat only — not loaded). */
  has_embeddings_file: boolean;
  embeddings_path: string;
  from_cache: boolean;
  /**
   * When true, Ask should use portable Access Indices (no legacy fulltext/exact shards).
   * Set ASK_FORCE_LEGACY_SEARCH=1 to disable.
   */
  access_index_mode: boolean;
};

type EmbeddingsEntry = {
  fingerprint: string;
  embeddingsById: Map<string, SearchEmbeddingRecord>;
};

type SearchEntry = {
  fingerprint: string;
  bundle: Omit<ProjectSearchBundle, "from_cache">;
};

type JsonlEntry = {
  fingerprint: string;
  raw: string;
};

const searchCache = new Map<string, SearchEntry>();
const embeddingsCache = new Map<string, EmbeddingsEntry>();
const jsonlRawCache = new Map<string, JsonlEntry>();

function projectDataRoot(project: LocalProject): string {
  const override = project.local_data_root?.trim();
  if (override) return path.resolve(override);
  return path.join(getLocalDataRoot(), project.customer_id);
}

function resolveIndexDir(project: LocalProject): string {
  const root = projectDataRoot(project);
  const rel = project.active_index_path.replace(/^\/+/, "") || "indexes/search";
  return path.join(root, rel);
}

export function projectCacheKey(project: LocalProject): string {
  const customer = project.customer_id?.trim() || "unknown";
  const root = projectDataRoot(project);
  const indexRel =
    project.active_index_path.replace(/^\/+/, "") || "indexes/search";
  return `${customer}::${root}::${indexRel}`;
}

export function stampFile(absPath: string): FileStamp | null {
  try {
    if (!existsSync(absPath)) return null;
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    return { path: absPath, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function fingerprintStamps(stamps: Array<FileStamp | null>): string {
  return stamps
    .filter((s): s is FileStamp => Boolean(s))
    .map((s) => `${s.path}|${s.mtimeMs}|${s.size}`)
    .sort()
    .join(";");
}

function indexSourcePaths(indexDir: string): string[] {
  return [
    path.join(indexDir, "search_documents.jsonl"),
    path.join(indexDir, "exact_index.json"),
    path.join(indexDir, "fulltext_index.json"),
    path.join(indexDir, "metadata_index.json"),
    path.join(indexDir, "relation_index.json"),
    path.join(indexDir, "vector_index.jsonl"),
    path.join(indexDir, "index_manifest.json"),
  ];
}

function computeSearchFingerprint(indexDir: string): string {
  return fingerprintStamps(indexSourcePaths(indexDir).map(stampFile));
}

function loadLocalIndexFromDisk(indexDir: string): LocalSearchIndex {
  askPerfBegin("canonical_graph_or_index_load");
  const readJson = <T>(name: string, kind: string, fallback: T): T => {
    const abs = path.join(indexDir, name);
    if (!existsSync(abs)) return fallback;
    const { parsed } = askPerfTrackedReadFile(abs, kind, {
      parse: (raw) => JSON.parse(raw) as T,
    });
    return (parsed as T) ?? fallback;
  };
  const vectorPath = path.join(indexDir, "vector_index.jsonl");
  let vector_index: LocalSearchIndex["vector_index"] = [];
  if (existsSync(vectorPath)) {
    const { parsed } = askPerfTrackedReadFile(vectorPath, "vector_index.jsonl", {
      parse: (raw) =>
        raw
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l)),
    });
    vector_index = (parsed as LocalSearchIndex["vector_index"]) ?? [];
  }
  const emptyManifest: LocalSearchIndex["manifest"] = {
    at: "",
    document_count: 0,
    embedding_count: 0,
    embedding_model: "",
    embedding_version: "",
    dimensions: 0,
    content_fingerprint: "",
  };
  const index: LocalSearchIndex = {
    exact_index: readJson("exact_index.json", "exact_index.json", {}),
    fulltext_index: readJson("fulltext_index.json", "fulltext_index.json", {}),
    metadata_index: readJson("metadata_index.json", "metadata_index.json", {}),
    relation_index: readJson("relation_index.json", "relation_index.json", []),
    vector_index,
    manifest: existsSync(path.join(indexDir, "index_manifest.json"))
      ? readJson("index_manifest.json", "index_manifest.json", emptyManifest)
      : emptyManifest,
  };
  askPerfSetIndexLoaded(true, false);
  askPerfNote(`Search index loaded from disk (not rebuilt): ${indexDir}`);
  askPerfEnd("canonical_graph_or_index_load");
  return index;
}

function loadDocumentsFromDisk(docsPath: string): SearchDocument[] {
  askPerfBegin("search_documents_load");
  const { parsed } = askPerfTrackedReadFile(
    docsPath,
    "search:search_documents.jsonl",
    {
      parse: (raw) => [...parseSearchDocumentsJsonl(raw).values()],
    },
  );
  askPerfEnd("search_documents_load");
  return (parsed as SearchDocument[]) ?? [];
}

function emptyLocalSearchIndex(): LocalSearchIndex {
  return {
    exact_index: {},
    fulltext_index: {},
    metadata_index: {},
    relation_index: [],
    vector_index: [],
    manifest: {
      at: "",
      document_count: 0,
      embedding_count: 0,
      embedding_model: "",
      embedding_version: "",
      dimensions: 0,
      content_fingerprint: "",
    },
  };
}

function forceLegacySearch(): boolean {
  return process.env.ASK_FORCE_LEGACY_SEARCH === "1";
}

/**
 * Documents + local search index for a project (shared across inspect + search).
 * When portable Access Indices are ready: skip legacy fulltext/exact/vector shard loads.
 */
export function getProjectSearchBundle(
  project: LocalProject,
): ProjectSearchBundle {
  const cache_key = projectCacheKey(project);
  const data_root = projectDataRoot(project);
  const index_dir = resolveIndexDir(project);
  const docs_path = path.join(index_dir, "search_documents.jsonl");
  const embeddings_path = path.join(
    data_root,
    "embeddings",
    "search",
    "search_embeddings.jsonl",
  );
  const fpBase = computeSearchFingerprint(index_dir);
  const projectKey = project.customer_id?.trim() || "P01";
  const portableReady = isPortableIndexReady(projectKey) && !forceLegacySearch();
  const portableFp = portableReady
    ? loadPortableManifest(projectKey)?.sources_fingerprint ?? ""
    : "";
  const fp = `${fpBase}::portable:${portableFp.slice(0, 16)}::access:${portableReady ? "1" : "0"}`;
  const embStamp = stampFile(embeddings_path);
  const has_embeddings_file = Boolean(embStamp && embStamp.size > 0);

  const cached = searchCache.get(cache_key);
  if (cached && cached.fingerprint === fp) {
    askPerfNote(
      `projectSearchBundle cache HIT (${cached.bundle.documents.length} docs, access=${cached.bundle.access_index_mode})`,
    );
    askPerfSetIndexLoaded(true, false);
    return { ...cached.bundle, from_cache: true, has_embeddings_file };
  }

  askPerfNote(
    cached
      ? "projectSearchBundle cache MISS (fingerprint changed)"
      : "projectSearchBundle cache MISS (cold)",
  );

  // --- Access Index mode: no legacy 191MB shards, no full evidence preload ---
  if (portableReady) {
    askPerfNote(
      "projectSearchBundle ACCESS_INDEX mode (skip legacy fulltext/exact/evidence full load)",
    );
    askPerfSetIndexLoaded(true, false);
    const bundle: Omit<ProjectSearchBundle, "from_cache"> = {
      cache_key,
      fingerprint: fp,
      data_root,
      index_dir,
      docs_path,
      documents: [],
      documentsById: new Map(),
      index: emptyLocalSearchIndex(),
      has_embeddings_file,
      embeddings_path,
      access_index_mode: true,
    };
    searchCache.set(cache_key, { fingerprint: fp, bundle });
    return { ...bundle, from_cache: false };
  }

  if (forceLegacySearch()) {
    askPerfNote("ASK_FORCE_LEGACY_SEARCH=1 — loading legacy search shards");
  }

  let documents: SearchDocument[] = [];
  let documentsById = new Map<string, SearchDocument>();

  // Legacy path: prefer portable evidence dump if present, else search_documents
  if (isPortableIndexReady(projectKey)) {
    const maps = loadPortableEvidenceMaps(projectKey);
    if (maps && maps.byId.size > 0) {
      documents = [...maps.byId.values()];
      documentsById = maps.byId;
      askPerfNote(
        `projectSearchBundle evidence from portable-store (${documents.length} docs)`,
      );
    }
  }

  if (documents.length === 0) {
    if (!existsSync(docs_path)) {
      const emptyIndex = loadLocalIndexFromDisk(index_dir);
      const bundle: Omit<ProjectSearchBundle, "from_cache"> = {
        cache_key,
        fingerprint: fp,
        data_root,
        index_dir,
        docs_path,
        documents: [],
        documentsById: new Map(),
        index: emptyIndex,
        has_embeddings_file,
        embeddings_path,
        access_index_mode: false,
      };
      return { ...bundle, from_cache: false };
    }
    askPerfNote("projectSearchBundle evidence fallback: indexes/search");
    documents = loadDocumentsFromDisk(docs_path);
    documentsById = new Map(
      documents.map((d) => [d.search_document_id, d]),
    );
  }

  const index = loadLocalIndexFromDisk(index_dir);
  const bundle: Omit<ProjectSearchBundle, "from_cache"> = {
    cache_key,
    fingerprint: fp,
    data_root,
    index_dir,
    docs_path,
    documents,
    documentsById,
    index,
    has_embeddings_file,
    embeddings_path,
    access_index_mode: false,
  };
  searchCache.set(cache_key, { fingerprint: fp, bundle });
  return { ...bundle, from_cache: false };
}

/**
 * Lazy-load embeddings only when vector search is actually needed.
 */
export function getProjectEmbeddings(
  project: LocalProject,
): Map<string, SearchEmbeddingRecord> {
  const cache_key = projectCacheKey(project);
  const data_root = projectDataRoot(project);
  const embPath = path.join(
    data_root,
    "embeddings",
    "search",
    "search_embeddings.jsonl",
  );
  const stamp = stampFile(embPath);
  if (!stamp || stamp.size <= 0) {
    return new Map();
  }
  const fp = fingerprintStamps([stamp]);
  const cached = embeddingsCache.get(cache_key);
  if (cached && cached.fingerprint === fp) {
    askPerfNote(
      `embeddings cache HIT (${cached.embeddingsById.size} vectors)`,
    );
    return cached.embeddingsById;
  }

  askPerfBegin("embeddings_load");
  askPerfNote(
    cached
      ? "embeddings cache MISS (fingerprint changed)"
      : "embeddings cache MISS (cold)",
  );
  const { parsed } = askPerfTrackedReadFile(embPath, "search_embeddings.jsonl", {
    parse: (raw) => parseEmbeddingsJsonl(raw),
  });
  const embeddingsById =
    (parsed as Map<string, SearchEmbeddingRecord>) ??
    new Map<string, SearchEmbeddingRecord>();
  askPerfEnd("embeddings_load");
  embeddingsCache.set(cache_key, { fingerprint: fp, embeddingsById });
  return embeddingsById;
}

/** Cached UTF-8 JSONL body (e.g. canonical code_units) — avoid re-read on warm. */
export function getCachedUtf8File(absPath: string, kind: string): string {
  const stamp = stampFile(absPath);
  if (!stamp) return "";
  const fp = fingerprintStamps([stamp]);
  const cached = jsonlRawCache.get(absPath);
  if (cached && cached.fingerprint === fp) {
    askPerfTrackedReadFile(absPath, kind, { cacheHit: true });
    return cached.raw;
  }
  const { raw } = askPerfTrackedReadFile(absPath, kind);
  if (raw) jsonlRawCache.set(absPath, { fingerprint: fp, raw });
  return raw;
}

/**
 * Fingerprint of lexical corpus source files (stat only).
 * Used to invalidate lexical corpus without a full rebuild.
 */
export function lexicalSourceFingerprint(projectKey: string): string {
  const stamps: Array<FileStamp | null> = [];
  const push = (abs: string) => {
    stamps.push(stampFile(abs));
  };

  try {
    push(
      resolveProjectZonePath(
        projectKey,
        "canonical",
        "control-tables",
        "table_definitions.jsonl",
      ),
    );
    push(
      resolveProjectZonePath(
        projectKey,
        "canonical",
        "control-tables",
        "table_entities.jsonl",
      ),
    );
    push(
      resolveProjectZonePath(
        projectKey,
        "canonical",
        "control-tables",
        "table_classifications.jsonl",
      ),
    );
    push(
      resolveProjectZonePath(
        projectKey,
        "canonical",
        "message-idoc-config",
        "objects.jsonl",
      ),
    );
    for (const zone of ["classes", "programs", "function-modules"] as const) {
      push(
        resolveProjectZonePath(
          projectKey,
          "canonical",
          zone,
          "code_units.jsonl",
        ),
      );
    }
  } catch {
    // resolve may throw if LOCAL_DATA_ROOT missing
  }

  // master-data/**/structure.jsonl — stat walk only
  try {
    const mdRoot = resolveProjectZonePath(
      projectKey,
      "canonical",
      "master-data",
    );
    if (existsSync(mdRoot)) {
      for (const domain of ["customers", "materials", "vendors"] as const) {
        const domainDir = path.join(mdRoot, domain);
        if (!existsSync(domainDir) || !statSync(domainDir).isDirectory()) {
          continue;
        }
        for (const table of readdirSync(domainDir)) {
          push(path.join(domainDir, table, "structure.jsonl"));
        }
      }
    }
  } catch {
    // ignore
  }

  return fingerprintStamps(stamps);
}

export function clearProjectKnowledgeCache(): void {
  searchCache.clear();
  embeddingsCache.clear();
  jsonlRawCache.clear();
}
