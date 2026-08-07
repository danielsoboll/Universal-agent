import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import { resolveWritablePath } from "@/lib/localData/paths";

export const PORTABLE_MANIFEST_NAME = "portable-manifest.json";

export function portableIndexRoot(
  projectId: string,
  dataRoot?: string,
): string {
  const root = dataRoot ?? getLocalDataRoot();
  return path.join(root, projectId, "indexes");
}

export function portableSubdir(
  projectId: string,
  name:
    | "symbol-index"
    | "lexical-index"
    | "graph-index"
    | "evidence-store"
    | "vector-index"
    | "literal-index",
  dataRoot?: string,
): string {
  return path.join(portableIndexRoot(projectId, dataRoot), name);
}

export function portableManifestPath(
  projectId: string,
  dataRoot?: string,
): string {
  return path.join(
    portableIndexRoot(projectId, dataRoot),
    PORTABLE_MANIFEST_NAME,
  );
}

/** Absolute path under project data root from a project-relative path. */
export function resolveProjectRelative(
  projectId: string,
  relativePath: string,
  dataRoot?: string,
): string {
  const root = dataRoot ?? getLocalDataRoot();
  const rel = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
  return path.join(root, projectId, ...rel.split("/"));
}

export function toProjectRelative(
  projectId: string,
  absolutePath: string,
  dataRoot?: string,
): string {
  const root = path.join(dataRoot ?? getLocalDataRoot(), projectId);
  const abs = path.resolve(absolutePath);
  const base = path.resolve(root);
  if (abs === base) return "";
  if (abs.startsWith(base + path.sep)) {
    return abs.slice(base.length + 1).split(path.sep).join("/");
  }
  // Fallback: strip known zone prefixes if path escapes (should not happen)
  return abs.split(path.sep).join("/");
}

export function ensurePortableWritable(
  projectId: string,
  ...parts: string[]
): string {
  return resolveWritablePath(projectId, "indexes", ...parts);
}
