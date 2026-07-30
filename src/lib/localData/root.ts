import { existsSync, statSync } from "fs";
import path from "path";
import { LocalDataError } from "@/lib/localData/errors";

/**
 * Reads LOCAL_DATA_ROOT from the environment (.env.local locally).
 * Never hardcode absolute customer paths in source.
 */
export function getLocalDataRoot(): string {
  const raw = process.env.LOCAL_DATA_ROOT?.trim();
  if (!raw) {
    throw new LocalDataError(
      "MISSING_ROOT",
      "LOCAL_DATA_ROOT fehlt. Bitte in .env.local setzen (absoluter Pfad außerhalb des Git-Repos, z. B. zu SAP_AI_Exports).",
    );
  }

  if (raw.includes("\0")) {
    throw new LocalDataError(
      "INVALID_ROOT",
      "LOCAL_DATA_ROOT ist ungültig (Null-Byte).",
    );
  }

  if (!path.isAbsolute(raw)) {
    throw new LocalDataError(
      "INVALID_ROOT",
      `LOCAL_DATA_ROOT muss ein absoluter Pfad sein, erhalten: "${raw}"`,
    );
  }

  const root = path.resolve(raw);

  if (!existsSync(root)) {
    throw new LocalDataError(
      "INVALID_ROOT",
      `LOCAL_DATA_ROOT existiert nicht: ${root}`,
    );
  }

  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch (cause) {
    throw new LocalDataError(
      "INVALID_ROOT",
      `LOCAL_DATA_ROOT ist nicht lesbar: ${root}`,
      { cause },
    );
  }

  if (!isDirectory) {
    throw new LocalDataError(
      "INVALID_ROOT",
      `LOCAL_DATA_ROOT ist kein Verzeichnis: ${root}`,
    );
  }

  return root;
}
