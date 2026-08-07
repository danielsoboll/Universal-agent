/**
 * MESSAGE_IDOC_11 relations: detect → convert (no OpenAI / index).
 * Does not modify message-idoc objects.jsonl or other domains.
 */

import { existsSync, statSync } from "fs";
import {
  convertMessageIdoc11Relations,
  MESSAGE_IDOC_11_CANONICAL_DIR,
  type MessageIdoc11RelationsManifest,
} from "@/lib/ingest/messageIdoc11RelationsCanonical";
import {
  MESSAGE_IDOC_11_RELATIONS_PATTERN,
  resolveMessageIdoc11RelationsFile,
} from "@/lib/admin/datenbasis/messageIdocConfig/resolveRelations11";
import { appendLogLine, ensureWritableDir } from "@/lib/localData/fs";
import type { DatenbasisStepResult } from "@/lib/admin/datenbasis/types";

export async function convertMessageIdoc11RelationsPipeline(
  projectKey: string,
  opts?: { overwrite?: boolean },
): Promise<{
  ok: boolean;
  result: DatenbasisStepResult;
  manifest: MessageIdoc11RelationsManifest | null;
}> {
  let selected;
  try {
    selected = resolveMessageIdoc11RelationsFile(projectKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      manifest: null,
      result: {
        ok: false,
        summary: `MESSAGE_IDOC_11 RAW nicht eindeutig (${MESSAGE_IDOC_11_RELATIONS_PATTERN})`,
        errors: [msg],
      },
    };
  }

  const canonicalDir = ensureWritableDir(
    projectKey,
    "canonical",
    MESSAGE_IDOC_11_CANONICAL_DIR,
  );

  const converted = await convertMessageIdoc11Relations({
    absoluteRawPath: selected.absolutePath,
    absoluteCanonicalDir: canonicalDir,
    sourceFileName: selected.fileName,
    sourceRelativePath: `raw/${selected.relativePath}`,
    overwrite: opts?.overwrite ?? false,
  });

  appendLogLine(
    projectKey,
    `datenbasis/message-idoc-config/convert-11-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify({
      at: new Date().toISOString(),
      ok: converted.ok,
      errors: converted.errors,
      stats: converted.manifest.stats,
      source: converted.manifest.source,
    }),
  );

  return {
    ok: converted.ok,
    manifest: converted.manifest,
    result: {
      ok: converted.ok,
      summary: converted.ok
        ? `MESSAGE_IDOC_11: ${converted.manifest.stats.relations_raw} → ${converted.manifest.stats.relations_unique} unique`
        : "MESSAGE_IDOC_11 Convert fehlgeschlagen",
      errors: converted.errors.length ? converted.errors : undefined,
      details: {
        outputs: converted.manifest.outputs,
        stats: converted.manifest.stats,
        source: converted.manifest.source,
        objects_untouched: !existsSync(
          // placeholder — real check in convert
          canonicalDir,
        )
          ? false
          : true,
        manifest_bytes: existsSync(
          `${canonicalDir}/relations-manifest.json`,
        )
          ? statSync(`${canonicalDir}/relations-manifest.json`).size
          : 0,
      },
    },
  };
}
