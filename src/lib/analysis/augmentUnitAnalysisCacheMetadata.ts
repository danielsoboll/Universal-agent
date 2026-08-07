/**
 * Atomic, lossless cache-metadata backfill for unit_analyses.jsonl.
 * Adds source_hash / analysis_schema_version / model_version when missing.
 * Never deletes rows; never changes analysis content fields.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  unlinkSync,
} from "fs";
import path from "path";
import { createInterface } from "readline";
import { finished } from "stream/promises";
import { withCacheMetadata } from "@/lib/analysis/unitAnalysisCache";
import {
  UNIT_ANALYSIS_SCHEMA_VERSION,
  unitAnalysisRecordSchema,
  type UnitAnalysisRecord,
} from "@/lib/analysis/unitAnalysisSchema";

export type AugmentCacheMetadataStats = {
  path: string;
  lines_in: number;
  lines_out: number;
  augmented: number;
  unchanged: number;
  skipped_invalid: number;
  schema_version: string;
};

function needsAugment(record: UnitAnalysisRecord): boolean {
  if (!record.source_hash?.trim()) return true;
  if (!record.analysis_schema_version?.trim()) return true;
  if (!record.model_version?.trim()) return true;
  return false;
}

export async function augmentUnitAnalysisCacheMetadata(params: {
  absolutePath: string;
  schemaVersion?: string;
}): Promise<AugmentCacheMetadataStats> {
  const schemaVersion =
    params.schemaVersion ?? UNIT_ANALYSIS_SCHEMA_VERSION;
  const abs = params.absolutePath;
  const stats: AugmentCacheMetadataStats = {
    path: abs,
    lines_in: 0,
    lines_out: 0,
    augmented: 0,
    unchanged: 0,
    skipped_invalid: 0,
    schema_version: schemaVersion,
  };

  if (!existsSync(abs)) {
    return stats;
  }

  const tmp = `${abs}.cache-meta.tmp`;
  const bak = `${abs}.cache-meta.bak`;

  const out = createWriteStream(tmp, { encoding: "utf8" });
  const rl = createInterface({
    input: createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      stats.lines_in += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        stats.skipped_invalid += 1;
        out.write(`${line}\n`);
        stats.lines_out += 1;
        continue;
      }
      const safe = unitAnalysisRecordSchema.safeParse(parsed);
      if (!safe.success) {
        stats.skipped_invalid += 1;
        out.write(`${line}\n`);
        stats.lines_out += 1;
        continue;
      }
      const record = safe.data;
      if (!needsAugment(record)) {
        stats.unchanged += 1;
        out.write(`${JSON.stringify(record)}\n`);
        stats.lines_out += 1;
        continue;
      }
      const augmented = withCacheMetadata(record, schemaVersion);
      const withModelVersion: UnitAnalysisRecord = {
        ...augmented,
        model_version: augmented.model_version?.trim() || augmented.model,
      };
      stats.augmented += 1;
      out.write(`${JSON.stringify(withModelVersion)}\n`);
      stats.lines_out += 1;
    }
  } finally {
    rl.close();
  }

  out.end();
  await finished(out);

  // Atomic swap: keep backup of previous file, then replace.
  if (existsSync(bak)) unlinkSync(bak);
  renameSync(abs, bak);
  try {
    renameSync(tmp, abs);
  } catch (err) {
    // Restore previous file if swap fails.
    if (existsSync(bak) && !existsSync(abs)) renameSync(bak, abs);
    throw err;
  }
  // Keep .bak until caller confirms; delete after successful swap to avoid clutter.
  if (existsSync(bak)) unlinkSync(bak);

  return stats;
}

export function resolveAnalysesPath(
  projectRootAnalysesFile: string,
): string {
  return path.resolve(projectRootAnalysesFile);
}
