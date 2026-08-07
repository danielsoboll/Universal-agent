import { existsSync, statSync } from "fs";
import { listRawEntries } from "@/lib/localData/fs";
import { LocalDataError } from "@/lib/localData/errors";
import { resolveRawPath } from "@/lib/localData/paths";

export type ExactlyOneRawFile = {
  fileName: string;
  relativePath: string;
  absolutePath: string;
  bytes: number;
};

/**
 * Match filenames against a simple glob with a single `*` wildcard
 * (e.g. `*_MESSAGE_IDOC_11_RELATIONS.jsonl`).
 * Requires exactly one match — 0 or >1 is an error.
 */
export function resolveExactlyOneRawFile(
  projectKey: string,
  rawParts: readonly string[],
  fileNamePattern: string,
): ExactlyOneRawFile {
  const absDir = resolveRawPath(projectKey, ...rawParts);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    throw new LocalDataError(
      "NOT_FOUND",
      `RAW-Ordner fehlt: raw/${rawParts.join("/")} (Muster ${fileNamePattern})`,
    );
  }

  let entries: string[];
  try {
    entries = listRawEntries(projectKey, ...rawParts);
  } catch (cause) {
    throw new LocalDataError(
      "NOT_FOUND",
      `RAW-Ordner nicht lesbar: raw/${rawParts.join("/")}`,
      { cause },
    );
  }

  const matcher = compileSimpleGlob(fileNamePattern);
  const hits = entries
    .filter((name) => {
      if (name.startsWith(".") || name.startsWith("_")) return false;
      if (!matcher(name)) return false;
      const abs = resolveRawPath(projectKey, ...rawParts, name);
      return existsSync(abs) && statSync(abs).isFile();
    })
    .sort((a, b) => a.localeCompare(b, "en"));

  if (hits.length === 0) {
    throw new LocalDataError(
      "NOT_FOUND",
      `Keine Datei für Muster ${fileNamePattern} in raw/${rawParts.join("/")}`,
    );
  }
  if (hits.length > 1) {
    throw new LocalDataError(
      "INVALID_PROJECT",
      `${hits.length} Treffer für Muster ${fileNamePattern} in raw/${rawParts.join("/")} — erwartet genau 1:\n  ${hits.join("\n  ")}`,
    );
  }

  const fileName = hits[0]!;
  const absolutePath = resolveRawPath(projectKey, ...rawParts, fileName);
  return {
    fileName,
    relativePath: `${rawParts.join("/")}/${fileName}`,
    absolutePath,
    bytes: statSync(absolutePath).size,
  };
}

function compileSimpleGlob(pattern: string): (name: string) => boolean {
  // Escape regex specials except our single `*` wildcards.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const re = new RegExp(`^${escaped}$`, "i");
  return (name: string) => re.test(name);
}
