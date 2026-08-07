/**
 * Hardened unit-analysis cache key and hit/miss evaluation.
 *
 * Binding key parts:
 * - source_key
 * - content_hash / source_hash (same value; content_hash is canonical store field)
 * - prompt_version
 * - model / model_version
 * - analysis_schema_version
 */
import { AI_CONFIG } from "@/lib/ai/config";
import {
  UNIT_ANALYSIS_PROMPT_VERSION,
  UNIT_ANALYSIS_SCHEMA_VERSION,
  type UnitAnalysisRecord,
} from "@/lib/analysis/unitAnalysisSchema";

export type UnitAnalysisCacheKey = {
  source_key: string;
  content_hash: string;
  source_hash: string;
  prompt_version: string;
  model: string;
  model_version: string;
  analysis_schema_version: string;
};

export type UnitAnalysisCacheMissReason =
  | "missing"
  | "needs_reanalysis"
  | "content_hash_mismatch"
  | "source_hash_mismatch"
  | "prompt_version_mismatch"
  | "model_mismatch"
  | "analysis_schema_version_mismatch";

export type UnitAnalysisCacheDecision =
  | {
      hit: true;
      reason: "cache_hit";
      key: UnitAnalysisCacheKey;
    }
  | {
      hit: false;
      reason: UnitAnalysisCacheMissReason;
      key: UnitAnalysisCacheKey;
      detail?: string;
    };

export function buildUnitAnalysisCacheKey(params: {
  source_key: string;
  contentHash: string;
  promptVersion?: string;
  model?: string;
  analysisSchemaVersion?: string;
}): UnitAnalysisCacheKey {
  const content_hash = params.contentHash;
  const model = params.model ?? AI_CONFIG.chatModel;
  return {
    source_key: params.source_key,
    content_hash,
    source_hash: content_hash,
    prompt_version: params.promptVersion ?? UNIT_ANALYSIS_PROMPT_VERSION,
    model,
    model_version: model,
    analysis_schema_version:
      params.analysisSchemaVersion ?? UNIT_ANALYSIS_SCHEMA_VERSION,
  };
}

/** Effective source_hash: explicit field or legacy content_hash. */
export function effectiveSourceHash(
  record: Pick<UnitAnalysisRecord, "content_hash" | "source_hash">,
): string {
  const sh = record.source_hash?.trim();
  if (sh) return sh;
  return record.content_hash;
}

/**
 * Grandfather missing analysis_schema_version as current when other key parts match.
 * Avoids invalidating the entire cache when the field is first introduced.
 */
export function effectiveAnalysisSchemaVersion(
  record: Pick<UnitAnalysisRecord, "analysis_schema_version">,
  expected = UNIT_ANALYSIS_SCHEMA_VERSION,
): string {
  const v = record.analysis_schema_version?.trim();
  if (v) return v;
  return expected;
}

export function evaluateUnitAnalysisCache(params: {
  existing: UnitAnalysisRecord | undefined;
  source_key: string;
  contentHash: string;
  promptVersion?: string;
  model?: string;
  analysisSchemaVersion?: string;
}): UnitAnalysisCacheDecision {
  const key = buildUnitAnalysisCacheKey({
    source_key: params.source_key,
    contentHash: params.contentHash,
    promptVersion: params.promptVersion,
    model: params.model,
    analysisSchemaVersion: params.analysisSchemaVersion,
  });

  const existing = params.existing;
  if (!existing) {
    return { hit: false, reason: "missing", key };
  }
  if (existing.needs_reanalysis) {
    return {
      hit: false,
      reason: "needs_reanalysis",
      key,
      detail: "needs_reanalysis flag set",
    };
  }
  if (existing.content_hash !== key.content_hash) {
    return {
      hit: false,
      reason: "content_hash_mismatch",
      key,
      detail: `stored=${existing.content_hash} expected=${key.content_hash}`,
    };
  }
  const storedSourceHash = effectiveSourceHash(existing);
  if (storedSourceHash !== key.source_hash) {
    return {
      hit: false,
      reason: "source_hash_mismatch",
      key,
      detail: `stored=${storedSourceHash} expected=${key.source_hash}`,
    };
  }
  if (existing.prompt_version !== key.prompt_version) {
    return {
      hit: false,
      reason: "prompt_version_mismatch",
      key,
      detail: `stored=${existing.prompt_version} expected=${key.prompt_version}`,
    };
  }
  if (existing.model !== key.model) {
    return {
      hit: false,
      reason: "model_mismatch",
      key,
      detail: `stored=${existing.model} expected=${key.model}`,
    };
  }
  const storedSchema = effectiveAnalysisSchemaVersion(
    existing,
    key.analysis_schema_version,
  );
  if (storedSchema !== key.analysis_schema_version) {
    return {
      hit: false,
      reason: "analysis_schema_version_mismatch",
      key,
      detail: `stored=${storedSchema} expected=${key.analysis_schema_version}`,
    };
  }

  return { hit: true, reason: "cache_hit", key };
}

/** Attach missing cache metadata fields without changing analysis content. */
export function withCacheMetadata(
  record: UnitAnalysisRecord,
  schemaVersion = UNIT_ANALYSIS_SCHEMA_VERSION,
): UnitAnalysisRecord {
  const source_hash = effectiveSourceHash(record);
  return {
    ...record,
    source_hash,
    model_version: record.model_version?.trim() || record.model,
    analysis_schema_version:
      record.analysis_schema_version?.trim() || schemaVersion,
  };
}

export function formatCacheDecisionLog(
  decision: UnitAnalysisCacheDecision,
): string {
  if (decision.hit) {
    return `CACHE_HIT reason=cache_hit source_key=${decision.key.source_key} prompt=${decision.key.prompt_version} model=${decision.key.model} schema=${decision.key.analysis_schema_version} hash=${decision.key.content_hash.slice(0, 12)}`;
  }
  const detail = decision.detail ? ` detail=${decision.detail}` : "";
  return `CACHE_MISS reason=${decision.reason} source_key=${decision.key.source_key} prompt=${decision.key.prompt_version} model=${decision.key.model} schema=${decision.key.analysis_schema_version}${detail}`;
}
