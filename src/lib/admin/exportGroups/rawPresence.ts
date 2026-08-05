import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { resolveRawPath } from "@/lib/localData/paths";

/** True if any non-empty file exists under raw/{relativeParts}/ (depth-limited). */
export function rawFolderHasFiles(
  projectKey: string,
  relativeParts: string[],
  depth = 0,
): boolean {
  try {
    const abs = resolveRawPath(projectKey, ...relativeParts);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return false;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return false;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const child = path.join(abs, name);
      try {
        const st = statSync(child);
        if (st.isFile() && st.size > 0) return true;
        if (st.isDirectory() && depth < 3 && rawFolderHasFiles(
          projectKey,
          [...relativeParts, name],
          depth + 1,
        )) {
          return true;
        }
      } catch {
        /* skip */
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function splitRawTarget(rawTargetPath: string): string[] {
  return rawTargetPath
    .replace(/^raw\//, "")
    .split("/")
    .filter(Boolean);
}
