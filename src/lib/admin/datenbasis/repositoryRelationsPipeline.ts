/**
 * Repository-Relations Datenbasis pipeline (Detect → Validate → Convert Pass 1).
 * No OpenAI, no embeddings, no hybrid index.
 * Does not touch classes / programs / function-modules / message-idoc-config.
 */

import { existsSync, statSync } from "fs";
import {
  convertRepositoryRelationsPass1,
  REPOSITORY_RELATIONS_CANONICAL_DIR,
  REPOSITORY_RELATIONS_EXPORT_TYPE,
  REPOSITORY_RELATIONS_RAW_PARTS,
  REPOSITORY_RELATIONS_RAW_PATTERN,
  type RepositoryRelationsManifest,
} from "@/lib/ingest/repositoryRelationsCanonical";
import {
  appendLogLine,
  ensureWritableDir,
} from "@/lib/localData/fs";
import { resolveExactlyOneRawFile } from "@/lib/localData/resolveExactlyOneRawFile";
import { resolveWritablePath } from "@/lib/localData/paths";
import type { DatenbasisStepResult } from "@/lib/admin/datenbasis/types";

export type DetectRepositoryRelationsResult = {
  ok: boolean;
  result: DatenbasisStepResult;
  selected: {
    fileName: string;
    relativePath: string;
    absolutePath: string;
    bytes: number;
  } | null;
};

export async function detectRepositoryRelationsRaw(
  projectKey: string,
): Promise<DetectRepositoryRelationsResult> {
  try {
    const selected = resolveExactlyOneRawFile(
      projectKey,
      REPOSITORY_RELATIONS_RAW_PARTS,
      REPOSITORY_RELATIONS_RAW_PATTERN,
    );
    return {
      ok: true,
      selected,
      result: {
        ok: true,
        summary: `1 RAW-Datei erkannt: ${selected.fileName}`,
        details: {
          pattern: REPOSITORY_RELATIONS_RAW_PATTERN,
          fileName: selected.fileName,
          bytes: selected.bytes,
          relativePath: `raw/${selected.relativePath}`,
        },
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      selected: null,
      result: {
        ok: false,
        summary: "Repository-Relations RAW nicht eindeutig erkannt",
        errors: [msg],
      },
    };
  }
}

export type ValidateRepositoryRelationsResult = {
  ok: boolean;
  result: DatenbasisStepResult;
  header: Record<string, unknown> | null;
  lines: number;
  parse_errors: number;
};

export async function validateRepositoryRelationsJsonl(
  projectKey: string,
): Promise<ValidateRepositoryRelationsResult> {
  const detect = await detectRepositoryRelationsRaw(projectKey);
  if (!detect.ok || !detect.selected) {
    return {
      ok: false,
      header: null,
      lines: 0,
      parse_errors: 0,
      result: detect.result,
    };
  }

  const { createReadStream } = await import("fs");
  const { createInterface } = await import("readline");
  const rl = createInterface({
    input: createReadStream(detect.selected.absolutePath, {
      encoding: "utf8",
    }),
    crlfDelay: Infinity,
  });

  let lines = 0;
  let parse_errors = 0;
  let header: Record<string, unknown> | null = null;
  const recordTypes: Record<string, number> = {};

  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      lines += 1;
      try {
        const obj = JSON.parse(t) as unknown;
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          parse_errors += 1;
          continue;
        }
        const rec = obj as Record<string, unknown>;
        const rt = String(rec.record_type ?? "");
        recordTypes[rt] = (recordTypes[rt] ?? 0) + 1;
        if (rt === "header" && !header) header = rec;
      } catch {
        parse_errors += 1;
      }
    }
  } finally {
    rl.close();
  }

  const errors: string[] = [];
  if (!header) errors.push("Kein header-Record");
  else {
    if (header.export_type !== REPOSITORY_RELATIONS_EXPORT_TYPE) {
      errors.push(
        `export_type: erwartet ${REPOSITORY_RELATIONS_EXPORT_TYPE}, erhalten ${String(header.export_type)}`,
      );
    }
    if (header.record_type !== "header") {
      errors.push("record_type der Header-Zeile ist nicht 'header'");
    }
  }
  if (parse_errors > 0) {
    errors.push(`${parse_errors} JSON-Parse-Fehler`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    header,
    lines,
    parse_errors,
    result: {
      ok,
      summary: ok
        ? `Validierung OK (${lines} Zeilen, ${JSON.stringify(recordTypes)})`
        : `Validierung fehlgeschlagen`,
      errors: errors.length ? errors : undefined,
      details: {
        fileName: detect.selected.fileName,
        lines,
        parse_errors,
        record_types: recordTypes,
        header,
      },
    },
  };
}

export type ConvertRepositoryRelationsResult = {
  ok: boolean;
  result: DatenbasisStepResult;
  manifest: RepositoryRelationsManifest | null;
};

export async function convertRepositoryRelations(
  projectKey: string,
  opts?: { overwrite?: boolean },
): Promise<ConvertRepositoryRelationsResult> {
  const detect = await detectRepositoryRelationsRaw(projectKey);
  if (!detect.ok || !detect.selected) {
    return { ok: false, manifest: null, result: detect.result };
  }

  const validate = await validateRepositoryRelationsJsonl(projectKey);
  if (!validate.ok) {
    return { ok: false, manifest: null, result: validate.result };
  }

  const canonicalDir = ensureWritableDir(
    projectKey,
    "canonical",
    REPOSITORY_RELATIONS_CANONICAL_DIR,
  );

  const converted = await convertRepositoryRelationsPass1({
    absoluteRawPath: detect.selected.absolutePath,
    absoluteCanonicalDir: canonicalDir,
    sourceFileName: detect.selected.fileName,
    sourceRelativePath: `raw/${detect.selected.relativePath}`,
    overwrite: opts?.overwrite ?? false,
  });

  appendLogLine(
    projectKey,
    `datenbasis/repository-relations/convert-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
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
        ? `Pass 1 OK: ${converted.manifest.stats.source_objects_unique} Objekte, ${converted.manifest.stats.relations_unique} Relationen, ${converted.manifest.stats.unresolved_unique} unresolved`
        : `Pass 1 fehlgeschlagen`,
      errors: converted.errors.length ? converted.errors : undefined,
      details: {
        outputs: converted.manifest.outputs,
        stats: converted.manifest.stats,
        absoluteDir: resolveWritablePath(
          projectKey,
          "canonical",
          REPOSITORY_RELATIONS_CANONICAL_DIR,
        ),
        exists: existsSync(
          resolveWritablePath(
            projectKey,
            "canonical",
            REPOSITORY_RELATIONS_CANONICAL_DIR,
            "manifest.json",
          ),
        ),
        bytes: existsSync(
          resolveWritablePath(
            projectKey,
            "canonical",
            REPOSITORY_RELATIONS_CANONICAL_DIR,
            "manifest.json",
          ),
        )
          ? statSync(
              resolveWritablePath(
                projectKey,
                "canonical",
                REPOSITORY_RELATIONS_CANONICAL_DIR,
                "manifest.json",
              ),
            ).size
          : 0,
      },
    },
  };
}
