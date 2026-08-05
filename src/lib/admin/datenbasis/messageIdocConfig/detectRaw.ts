import { existsSync, statSync } from "fs";
import {
  CONFIG_GROUPS,
  RAW_FOLDER,
  RAW_FOLDER_PARTS,
  isConfigGroup,
  type MessageIdocConfigGroup,
} from "@/lib/admin/datenbasis/messageIdocConfig/constants";
import type { DetectedMessageIdocFile } from "@/lib/admin/datenbasis/messageIdocConfig/types";
import { listRawEntries } from "@/lib/localData/fs";
import { resolveRawPath } from "@/lib/localData/paths";

/**
 * Extract stable config_group from dynamic filenames like:
 *   D01_20260805_151000_MESSAGE_IDOC_01_OUTPUT_TYPES.jsonl
 *
 * Matching is by known group suffix — not a full static filename.
 * Longest match wins (avoids partial collisions).
 */
export function extractConfigGroupFromFileName(
  fileName: string,
): MessageIdocConfigGroup | null {
  const base = fileName.replace(/\.jsonl$/i, "").toUpperCase();
  let best: MessageIdocConfigGroup | null = null;
  for (const group of CONFIG_GROUPS) {
    if (
      (base === group || base.endsWith(`_${group}`) || base.includes(group)) &&
      (!best || group.length > best.length)
    ) {
      best = group;
    }
  }
  return best;
}

export function parseMissingTableNames(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(x).trim())
      .filter(Boolean)
      .sort();
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    return t
      .split(/[,;|\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
  }
  return [];
}

/**
 * Detect all JSONL under raw/message-idoc-config/.
 * No Z-/Y- filename filtering. Group from filename when possible.
 */
export function detectMessageIdocRawFiles(
  projectKey: string,
): DetectedMessageIdocFile[] {
  const absDir = resolveRawPath(projectKey, ...RAW_FOLDER_PARTS);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    return [];
  }

  let entries: string[];
  try {
    entries = listRawEntries(projectKey, ...RAW_FOLDER_PARTS);
  } catch {
    return [];
  }

  const out: DetectedMessageIdocFile[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    if (!name.toLowerCase().endsWith(".jsonl")) continue;
    const abs = resolveRawPath(projectKey, ...RAW_FOLDER_PARTS, name);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    out.push({
      fileName: name,
      relativePath: `${RAW_FOLDER}/${name}`,
      bytes: statSync(abs).size,
      configGroupFromFileName: extractConfigGroupFromFileName(name),
    });
  }

  out.sort((a, b) => a.fileName.localeCompare(b.fileName, "en"));
  return out;
}

export { isConfigGroup };
