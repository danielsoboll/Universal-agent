import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import type { LocalProject } from "@/lib/localAuth/types";
import { LocalDataError } from "@/lib/localData/errors";
import { BOUND_DATA_PROJECT_KEY } from "@/lib/localData/boundProject";
import { getLocalDataRoot } from "@/lib/localData/root";
import { parseSearchDocumentsJsonl } from "@/lib/search/buildSearchDocuments";
import { domainProfileIdForAppModule } from "@/lib/domain/capabilities";
import type { AppModuleKey } from "@/lib/onboarding/appProfileTypes";
import type { DomainProfileId } from "@/lib/domain/types";

/**
 * Local copy of `isAppModuleKey` (type-only import of `AppModuleKey` above).
 * `appProfileTypes.ts` is `server-only`-guarded, so it cannot be imported
 * with a runtime (value) import here — this file is also used by CLI
 * scripts (`scripts/ask.ts`) outside the Next.js server runtime.
 */
function isKnownAppModule(value: string): value is AppModuleKey {
  return (
    value === "general" ||
    value === "sap" ||
    value === "homepage" ||
    value === "database"
  );
}

export type KnowledgeProjectPaths = {
  projectId: string;
  customerId: string;
  systemId: string;
  localDataRoot: string;
  projectRoot: string;
  activeSearchIndexPath: string;
  activeEmbeddingPath: string;
  activeEvidenceRoot: string;
};

export type KnowledgeProjectResolution = KnowledgeProjectPaths & {
  project: LocalProject;
  source:
    | "local_repo"
    | "landscape_label"
    | "env_data_key"
    | "env_project_id"
    | "discovered_folder";
  documentCount: number;
  embeddingCount: number;
  vectorSearchConfigured: boolean;
};

export type ResolveKnowledgeErrorCode =
  | "unavailable"
  | "project_not_configured"
  | "index_missing"
  | "index_empty"
  | "index_unreadable"
  | "not_found"
  | "empty_index";

export type ResolveKnowledgeProjectResult =
  | { ok: true; resolution: KnowledgeProjectResolution }
  | {
      ok: false;
      code: ResolveKnowledgeErrorCode;
      /** User-facing German message — never includes absolute Mac paths. */
      message: string;
      /** Technical detail for server logs only. */
      detail?: string;
    };

export type ResolveAskProjectResult =
  | {
      ok: true;
      project: LocalProject;
      dataKey: string;
      source: KnowledgeProjectResolution["source"];
      resolution: KnowledgeProjectResolution;
    }
  | {
      ok: false;
      message: string;
      code: ResolveKnowledgeErrorCode;
      detail?: string;
    };

type IndexCandidate = {
  relativePath: string;
  docsPath: string;
  documentCount: number;
  hasHybridArtifacts: boolean;
  hasEmbeddings: boolean;
  embeddingPath: string;
  embeddingCount: number;
  mtimeMs: number;
  score: number;
};

const USER_MESSAGES: Record<
  Exclude<ResolveKnowledgeErrorCode, "unavailable" | "not_found" | "empty_index">,
  string
> = {
  project_not_configured: "Projekt nicht konfiguriert",
  index_missing: "Wissensindex fehlt",
  index_empty: "Wissensindex leer",
  index_unreadable: "Index nicht lesbar",
};

/**
 * Index selection under a project root.
 *
 * Rules (documented):
 * 1. Prefer `indexes/search` when it has schema-valid SearchDocuments (>0).
 * 2. Among remaining candidates, prefer hybrid artifacts (exact/fulltext indexes)
 *    and available embeddings over raw document dumps.
 * 3. Prefer higher document count, then newer mtime.
 * 4. Never invent a new index file; only pick an existing one.
 * 5. Selection is independent of any particular test question.
 */
export function discoverActiveSearchIndex(projectRoot: string): IndexCandidate | null {
  const embeddingsSearch = path.join(
    projectRoot,
    "embeddings",
    "search",
    "search_embeddings.jsonl",
  );
  const embeddingCount = countJsonlLines(embeddingsSearch);
  const hasSharedEmbeddings = embeddingCount > 0;

  const candidates: IndexCandidate[] = [];
  const indexesRoot = path.join(projectRoot, "indexes");
  if (!existsSync(indexesRoot)) return null;

  walkForSearchDocuments(indexesRoot, indexesRoot, (rel, docsPath) => {
    let documentCount = 0;
    try {
      documentCount = [
        ...parseSearchDocumentsJsonl(readFileSync(docsPath, "utf8")).values(),
      ].length;
    } catch {
      return;
    }
    if (documentCount <= 0) return;

    const indexDir = path.dirname(docsPath);
    const hasHybridArtifacts =
      existsSync(path.join(indexDir, "exact_index.json")) ||
      existsSync(path.join(indexDir, "fulltext_index.json")) ||
      existsSync(path.join(indexDir, "vector_index.jsonl"));

    const localEmb = path.join(indexDir, "search_embeddings.jsonl");
    const embPath = existsSync(localEmb) ? localEmb : embeddingsSearch;
    const embCount = embPath === embeddingsSearch
      ? embeddingCount
      : countJsonlLines(embPath);
    const hasEmbeddings = embCount > 0;

    const mtimeMs = safeMtime(docsPath);
    const isPreferredSearch =
      rel === "search" || rel === path.join("indexes", "search");

    let score = 0;
    if (isPreferredSearch) score += 100_000;
    if (hasHybridArtifacts) score += 10_000;
    if (hasEmbeddings || (isPreferredSearch && hasSharedEmbeddings)) {
      score += 5_000;
    }
    score += Math.min(documentCount, 50_000);
    score += mtimeMs / 1e15;

    candidates.push({
      relativePath: path.join("indexes", rel),
      docsPath,
      documentCount,
      hasHybridArtifacts,
      hasEmbeddings: hasEmbeddings || (isPreferredSearch && hasSharedEmbeddings),
      embeddingPath: embPath,
      embeddingCount: embCount || (isPreferredSearch ? embeddingCount : 0),
      mtimeMs,
      score,
    });
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

function walkForSearchDocuments(
  absDir: string,
  indexesRoot: string,
  onHit: (relFromIndexes: string, docsPath: string) => void,
) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      walkForSearchDocuments(abs, indexesRoot, onHit);
      continue;
    }
    if (ent.isFile() && ent.name === "search_documents.jsonl") {
      const rel = path.relative(indexesRoot, path.dirname(abs));
      onHit(rel || ".", abs);
    }
  }
}

function countJsonlLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    return readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function safeMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function folderExists(localDataRoot: string, key: string): boolean {
  if (!key || key.includes("\0") || key.includes("..")) return false;
  try {
    const p = path.join(localDataRoot, key);
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function pickFilesystemCustomerId(
  localDataRoot: string,
  candidates: Array<string | null | undefined>,
): string | null {
  for (const raw of candidates) {
    const key = raw?.trim();
    if (!key) continue;
    if (folderExists(localDataRoot, key)) return key;
  }
  return null;
}

function buildLocalProject(params: {
  id: string;
  name: string;
  customerId: string;
  systemId: string;
  activeIndexPath: string;
  description?: string;
  domainProfileId?: DomainProfileId;
}): LocalProject {
  const now = new Date().toISOString();
  return {
    id: params.id,
    name: params.name,
    description:
      params.description ??
      `Lokaler Wissensbestand (${params.customerId}/${params.systemId})`,
    customer_id: params.customerId,
    system_id: params.systemId,
    local_data_root: "",
    active_index_path: params.activeIndexPath,
    enabled_knowledge_unit_types: [],
    domain_profile_id: params.domainProfileId ?? "generic_documents",
    created_at: now,
    updated_at: now,
  };
}

function toUserFacingFailure(
  code: ResolveKnowledgeErrorCode,
  detail?: string,
): Extract<ResolveKnowledgeProjectResult, { ok: false }> {
  if (code === "unavailable") {
    return {
      ok: false,
      code,
      message:
        "Projekt nicht konfiguriert",
      detail,
    };
  }
  if (code === "not_found" || code === "project_not_configured") {
    return {
      ok: false,
      code: "project_not_configured",
      message: USER_MESSAGES.project_not_configured,
      detail,
    };
  }
  if (code === "empty_index" || code === "index_empty") {
    return {
      ok: false,
      code: "index_empty",
      message: USER_MESSAGES.index_empty,
      detail,
    };
  }
  if (code === "index_missing") {
    return {
      ok: false,
      code,
      message: USER_MESSAGES.index_missing,
      detail,
    };
  }
  return {
    ok: false,
    code: "index_unreadable",
    message: USER_MESSAGES.index_unreadable,
    detail,
  };
}

function validateResolvedProject(
  project: LocalProject,
  localDataRoot: string,
  candidate: IndexCandidate,
): Extract<ResolveKnowledgeProjectResult, { ok: false }> | null {
  const projectRoot = path.join(localDataRoot, project.customer_id);
  if (!existsSync(projectRoot)) {
    const detail = `projectRoot missing: ${projectRoot}`;
    console.error("[resolveKnowledgeProject]", detail);
    return toUserFacingFailure("project_not_configured", detail);
  }

  const docsPath = candidate.docsPath;
  if (!existsSync(docsPath)) {
    const detail = `search_documents.jsonl missing: ${docsPath}`;
    console.error("[resolveKnowledgeProject]", detail);
    return toUserFacingFailure("index_missing", detail);
  }

  let documentCount = 0;
  try {
    documentCount = [
      ...parseSearchDocumentsJsonl(readFileSync(docsPath, "utf8")).values(),
    ].length;
  } catch (e) {
    const detail = `index unreadable: ${docsPath} (${e instanceof Error ? e.message : String(e)})`;
    console.error("[resolveKnowledgeProject]", detail);
    return toUserFacingFailure("index_unreadable", detail);
  }

  if (documentCount <= 0) {
    const detail = `index empty: ${docsPath}`;
    console.error("[resolveKnowledgeProject]", detail);
    return toUserFacingFailure("index_empty", detail);
  }

  if (candidate.hasEmbeddings && candidate.embeddingCount <= 0) {
    const detail = `embeddings claimed but missing: ${candidate.embeddingPath}`;
    console.error("[resolveKnowledgeProject]", detail);
    // Soft: still allow lexical search; vector flag comes from retriever.
  }

  return null;
}

function finalize(
  project: LocalProject,
  localDataRoot: string,
  source: KnowledgeProjectResolution["source"],
): ResolveKnowledgeProjectResult {
  const projectRoot = path.join(localDataRoot, project.customer_id);
  const discovered = discoverActiveSearchIndex(projectRoot);

  const activeIndexPath =
    discovered?.relativePath ||
    project.active_index_path.replace(/^\/+/, "") ||
    "indexes/search";

  const candidate: IndexCandidate =
    discovered ??
    ({
      relativePath: activeIndexPath,
      docsPath: path.join(projectRoot, activeIndexPath, "search_documents.jsonl"),
      documentCount: 0,
      hasHybridArtifacts: false,
      hasEmbeddings: false,
      embeddingPath: path.join(
        projectRoot,
        "embeddings",
        "search",
        "search_embeddings.jsonl",
      ),
      embeddingCount: 0,
      mtimeMs: 0,
      score: 0,
    } satisfies IndexCandidate);

  // Prefer discovered path on the LocalProject so KnowledgeRetriever uses it.
  const resolvedProject: LocalProject = {
    ...project,
    active_index_path: candidate.relativePath,
    // Keep explicit profile; never invent "sap" here.
    domain_profile_id: project.domain_profile_id,
  };

  const failure = validateResolvedProject(
    resolvedProject,
    localDataRoot,
    candidate,
  );
  if (failure) return failure;

  const embeddingPath = candidate.embeddingPath;
  const embeddingCount = candidate.embeddingCount;
  const documentCount = candidate.documentCount;

  const resolution: KnowledgeProjectResolution = {
    projectId: resolvedProject.id,
    customerId: resolvedProject.customer_id,
    systemId: resolvedProject.system_id,
    localDataRoot,
    projectRoot,
    activeSearchIndexPath: path.join(projectRoot, candidate.relativePath),
    activeEmbeddingPath: embeddingPath,
    activeEvidenceRoot: path.join(projectRoot, "canonical"),
    project: resolvedProject,
    source,
    documentCount,
    embeddingCount,
    vectorSearchConfigured: embeddingCount > 0,
  };

  return { ok: true, resolution };
}

/**
 * Central knowledge-project path resolution for ask / RAG.
 *
 * Maps the signed-in session's project (Supabase customer UUID or local project id)
 * to filesystem keys under LOCAL_DATA_ROOT. `landscape_label` is only used as a
 * data-folder key when that folder actually exists — labels like "Intern" are
 * ignored for path composition.
 */
export async function resolveKnowledgeProject(params: {
  session?: { userId?: string | null } | null;
  projectId: string;
}): Promise<ResolveKnowledgeProjectResult> {
  void params.session; // reserved for future per-user project binding

  let localDataRoot: string;
  try {
    localDataRoot = getLocalDataRoot();
  } catch (e) {
    const detail =
      e instanceof LocalDataError
        ? e.message
        : "LOCAL_DATA_ROOT fehlt oder ist ungültig.";
    console.error("[resolveKnowledgeProject]", detail);
    return toUserFacingFailure("unavailable", detail);
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return toUserFacingFailure(
      "project_not_configured",
      "empty projectId",
    );
  }

  const envProjectId = process.env.LOCAL_ASK_PROJECT_ID?.trim();
  if (envProjectId) {
    const existing = await fileProjectRepository.getById(envProjectId);
    if (existing && folderExists(localDataRoot, existing.customer_id)) {
      return finalize(existing, localDataRoot, "env_project_id");
    }
  }

  const byId = await fileProjectRepository.getById(projectId);
  if (byId && folderExists(localDataRoot, byId.customer_id)) {
    let enriched = byId;
    if (!byId.domain_profile_id) {
      try {
        const { createClient } = await import("@/lib/supabase/server");
        const supabase = await createClient();
        const { data: customer } = await supabase
          .from("customers")
          .select("product_module")
          .eq("id", projectId)
          .maybeSingle();
        const productModule = customer?.product_module?.trim();
        if (productModule && isKnownAppModule(productModule)) {
          enriched = {
            ...byId,
            domain_profile_id: domainProfileIdForAppModule(productModule),
          };
        }
      } catch {
        /* CLI */
      }
    }
    return finalize(enriched, localDataRoot, "local_repo");
  }

  let landscapeLabel: string | null = null;
  let slug: string | null = null;
  let name = "Projekt";
  let domainProfileId: DomainProfileId | undefined;
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data: customer } = await supabase
      .from("customers")
      .select("id, name, slug, landscape_label, product_module")
      .eq("id", projectId)
      .maybeSingle();
    if (customer) {
      name = customer.name ?? name;
      slug = customer.slug ?? null;
      landscapeLabel = customer.landscape_label?.trim() || null;
      const productModule = customer.product_module?.trim();
      if (productModule && isKnownAppModule(productModule)) {
        domainProfileId = domainProfileIdForAppModule(productModule);
      }
    }
  } catch {
    /* CLI without Next runtime */
  }

  const envDataKey =
    process.env.NODE_ENV !== "production"
      ? process.env.LOCAL_KNOWLEDGE_DATA_KEY?.trim() || null
      : null;

  const localProjects = await fileProjectRepository.list();

  // universal-agent: immer P01 als Datenroot (fest verdrahtet)
  const usableKeys = [
    BOUND_DATA_PROJECT_KEY,
    envDataKey,
    landscapeLabel && folderExists(localDataRoot, landscapeLabel)
      ? landscapeLabel
      : null,
    slug && folderExists(localDataRoot, slug) ? slug : null,
  ].filter((k): k is string => Boolean(k));

  const matched = localProjects.find(
    (p) =>
      folderExists(localDataRoot, p.customer_id) &&
      (p.customer_id === BOUND_DATA_PROJECT_KEY ||
        usableKeys.includes(p.customer_id) ||
        p.id === projectId ||
        (slug && p.customer_id === slug)),
  );
  if (matched) {
    const enriched: LocalProject = {
      ...matched,
      domain_profile_id: matched.domain_profile_id ?? domainProfileId,
    };
    return finalize(enriched, localDataRoot, "local_repo");
  }

  // If landscape_label is only a display label (e.g. "Intern") and no folder
  // exists, fall back to env key / sole discovered data folder / local repo.
  const dataKey = pickFilesystemCustomerId(localDataRoot, [
    BOUND_DATA_PROJECT_KEY,
    envDataKey,
    landscapeLabel,
    ...localProjects.map((p) => p.customer_id),
  ]);

  if (!dataKey) {
    const detail = [
      `projectId=${projectId}`,
      `landscape_label=${landscapeLabel ?? "null"}`,
      `envDataKey=${envDataKey ?? "null"}`,
      `localDataRoot=${localDataRoot}`,
    ].join(" ");
    console.error("[resolveKnowledgeProject] no filesystem customer id", detail);
    return toUserFacingFailure("project_not_configured", detail);
  }

  const template =
    localProjects.find((p) => p.customer_id === dataKey) ?? null;

  const synthesized = buildLocalProject({
    id: projectId,
    name: template?.name ?? name,
    customerId: dataKey,
    systemId: template?.system_id ?? "D01",
    activeIndexPath: template?.active_index_path || "indexes/search",
    description: template?.description,
    domainProfileId: template?.domain_profile_id ?? domainProfileId,
  });

  const source: KnowledgeProjectResolution["source"] =
    landscapeLabel &&
    landscapeLabel === dataKey &&
    folderExists(localDataRoot, landscapeLabel)
      ? "landscape_label"
      : envDataKey && envDataKey === dataKey
        ? "env_data_key"
        : template
          ? "local_repo"
          : "discovered_folder";

  return finalize(synthesized, localDataRoot, source);
}

/**
 * Backward-compatible wrapper used by ask API / server actions.
 */
export async function resolveAskLocalProject(
  projectId: string,
): Promise<ResolveAskProjectResult> {
  const result = await resolveKnowledgeProject({ projectId });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      message: result.message,
      detail: result.detail,
    };
  }
  return {
    ok: true,
    project: result.resolution.project,
    dataKey: result.resolution.customerId,
    source: result.resolution.source,
    resolution: result.resolution,
  };
}
