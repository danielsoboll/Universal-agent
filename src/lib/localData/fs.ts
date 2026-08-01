import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { LocalDataError } from "@/lib/localData/errors";
import {
  assertRawReadPath,
  assertWritablePath,
  resolveRawPath,
  resolveWritablePath,
} from "@/lib/localData/paths";
import type { WritableZone } from "@/lib/localData/zones";

function requireExistingFile(absolutePath: string): void {
  if (!existsSync(absolutePath)) {
    throw new LocalDataError(
      "NOT_FOUND",
      `Datei nicht gefunden: ${absolutePath}`,
    );
  }
  if (!statSync(absolutePath).isFile()) {
    throw new LocalDataError(
      "NOT_FOUND",
      `Pfad ist keine Datei: ${absolutePath}`,
    );
  }
}

/** Read text from LOCAL_DATA_ROOT/{project}/raw/... — never writes. */
export function readRawText(
  projectKey: string,
  ...relativeParts: string[]
): string {
  const absolutePath = assertRawReadPath(
    resolveRawPath(projectKey, ...relativeParts),
  );
  requireExistingFile(absolutePath);
  return readFileSync(absolutePath, "utf8");
}

/** Read bytes from raw — never writes. */
export function readRawBuffer(
  projectKey: string,
  ...relativeParts: string[]
): Buffer {
  const absolutePath = assertRawReadPath(
    resolveRawPath(projectKey, ...relativeParts),
  );
  requireExistingFile(absolutePath);
  return readFileSync(absolutePath);
}

/** List entries directly under a raw subdirectory (read-only). */
export function listRawEntries(
  projectKey: string,
  ...relativeParts: string[]
): string[] {
  const absolutePath = assertRawReadPath(
    resolveRawPath(projectKey, ...relativeParts),
  );
  if (!existsSync(absolutePath)) {
    throw new LocalDataError(
      "NOT_FOUND",
      `Verzeichnis nicht gefunden: ${absolutePath}`,
    );
  }
  if (!statSync(absolutePath).isDirectory()) {
    throw new LocalDataError(
      "NOT_FOUND",
      `Pfad ist kein Verzeichnis: ${absolutePath}`,
    );
  }
  return readdirSync(absolutePath);
}

/**
 * Ensure a directory exists under a writable zone.
 * Never creates or touches anything under raw/.
 */
export function ensureWritableDir(
  projectKey: string,
  zone: WritableZone,
  ...relativeParts: string[]
): string {
  const absolutePath = assertWritablePath(
    resolveWritablePath(projectKey, zone, ...relativeParts),
  );
  mkdirSync(absolutePath, { recursive: true });
  return absolutePath;
}

/** Write a generated text file under a writable zone only. */
export function writeGeneratedText(
  projectKey: string,
  zone: WritableZone,
  relativeFilePath: string,
  content: string,
): string {
  const absolutePath = assertWritablePath(
    resolveWritablePath(projectKey, zone, relativeFilePath),
  );
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  return absolutePath;
}

/** Append a line to a log file under {project}/logs/... */
export function appendLogLine(
  projectKey: string,
  relativeLogFile: string,
  line: string,
): string {
  const absolutePath = assertWritablePath(
    resolveWritablePath(projectKey, "logs", relativeLogFile),
  );
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const payload = line.endsWith("\n") ? line : `${line}\n`;
  appendFileSync(absolutePath, payload, "utf8");
  return absolutePath;
}

/** List entries directly under a writable subdirectory (never raw/). */
export function listWritableEntries(
  projectKey: string,
  zone: WritableZone,
  ...relativeParts: string[]
): string[] {
  const absolutePath = assertWritablePath(
    resolveWritablePath(projectKey, zone, ...relativeParts),
  );
  if (!existsSync(absolutePath)) return [];
  if (!statSync(absolutePath).isDirectory()) {
    throw new LocalDataError(
      "NOT_FOUND",
      `Pfad ist kein Verzeichnis: ${absolutePath}`,
    );
  }
  return readdirSync(absolutePath);
}

/**
 * Delete a file or directory tree under a writable zone only.
 * Never touches raw/. Missing paths are ignored.
 */
export function deleteGeneratedPath(
  projectKey: string,
  zone: WritableZone,
  relativePath: string,
): { deleted: boolean; absolutePath: string } {
  const absolutePath = assertWritablePath(
    resolveWritablePath(projectKey, zone, relativePath),
  );
  if (!existsSync(absolutePath)) {
    return { deleted: false, absolutePath };
  }
  rmSync(absolutePath, { recursive: true, force: true });
  return { deleted: true, absolutePath };
}
