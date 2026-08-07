/**
 * MESSAGE_IDOC_11 Relations — Dateierkennung.
 *
 * Nicht auf den exakten Namen MESSAGE_IDOC_11_RELATIONS.jsonl prüfen.
 * Generisches Muster: *_MESSAGE_IDOC_11_RELATIONS.jsonl
 * Genau ein Treffer erforderlich.
 */

import { RAW_FOLDER_PARTS } from "@/lib/admin/datenbasis/messageIdocConfig/constants";
import {
  resolveExactlyOneRawFile,
  type ExactlyOneRawFile,
} from "@/lib/localData/resolveExactlyOneRawFile";

/** Glob-Muster (einfacher `*`-Wildcard), case-insensitive. */
export const MESSAGE_IDOC_11_RELATIONS_PATTERN =
  "*_MESSAGE_IDOC_11_RELATIONS.jsonl" as const;

/** Stabiles Suffix / Gruppenkennung (kein Teil der 10 CONTENT-Gruppen). */
export const MESSAGE_IDOC_11_RELATIONS_GROUP =
  "MESSAGE_IDOC_11_RELATIONS" as const;

export function resolveMessageIdoc11RelationsFile(
  projectKey: string,
): ExactlyOneRawFile {
  return resolveExactlyOneRawFile(
    projectKey,
    RAW_FOLDER_PARTS,
    MESSAGE_IDOC_11_RELATIONS_PATTERN,
  );
}

export function isMessageIdoc11RelationsFileName(fileName: string): boolean {
  const base = fileName.replace(/\.jsonl$/i, "").toUpperCase();
  return (
    base === MESSAGE_IDOC_11_RELATIONS_GROUP ||
    base.endsWith(`_${MESSAGE_IDOC_11_RELATIONS_GROUP}`)
  );
}
