import { createHash } from "crypto";
import { extractAbapArtifacts } from "@/lib/analysis/abapExtract";
import { compareExtractions } from "@/lib/analysis/extractionCompare";
import { enrichUnitAnalysisRecord } from "@/lib/analysis/enrichUnitAnalysis";
import {
  buildUnitAnalysisSystemPrompt,
  buildUnitAnalysisUserPrompt,
  numberSourceLines,
} from "@/lib/analysis/unitAnalysisPrompt";
import { repairUnitAnalysisRecord } from "@/lib/analysis/repairUnitAnalyses";
import {
  evaluateUnitAnalysisCache,
  formatCacheDecisionLog,
  withCacheMetadata,
  type UnitAnalysisCacheDecision,
} from "@/lib/analysis/unitAnalysisCache";
import {
  UNIT_ANALYSIS_PROMPT_VERSION,
  UNIT_ANALYSIS_SCHEMA_VERSION,
  unitAnalysisModelSchema,
  unitAnalysisRecordSchema,
  type UnitAnalysisErrorRecord,
  type UnitAnalysisRecord,
} from "@/lib/analysis/unitAnalysisSchema";
import { AI_CONFIG } from "@/lib/ai/config";
import { AIProviderError } from "@/lib/ai/errors";
import { OpenAIProvider } from "@/lib/ai/openaiProvider";

export type CodeUnitInput = {
  source_key: string;
  object_name: string;
  unit_name: string;
  unit_type?: string;
  include_name?: string;
  source_code: string;
};

export function hashUnitContent(sourceCode: string): string {
  return createHash("sha256").update(sourceCode, "utf8").digest("hex");
}

/**
 * @deprecated Prefer evaluateUnitAnalysisCache — kept for callers that only need boolean.
 */
export function shouldSkipExistingAnalysis(
  existing: UnitAnalysisRecord | undefined,
  contentHash: string,
  promptVersion = UNIT_ANALYSIS_PROMPT_VERSION,
  model = AI_CONFIG.chatModel,
  analysisSchemaVersion = UNIT_ANALYSIS_SCHEMA_VERSION,
): boolean {
  return evaluateUnitAnalysisCache({
    existing,
    source_key: existing?.source_key ?? "",
    contentHash,
    promptVersion,
    model,
    analysisSchemaVersion,
  }).hit;
}

export function parseCodeUnitsJsonl(text: string): CodeUnitInput[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const units: CodeUnitInput[] = [];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (String(value.record_type ?? "code_unit") !== "code_unit") continue;
    if (String(value.unit_type ?? "").toUpperCase() !== "METHOD") continue;

    const source_key = String(value.source_key ?? "").trim();
    const object_name = String(value.object_name ?? "").trim();
    const unit_name = String(value.unit_name ?? "").trim();
    const source_code =
      typeof value.source_code === "string" ? value.source_code : "";

    if (!source_key || !object_name || !unit_name || !source_code) {
      throw new Error(
        `Ungültige code_unit-Zeile (source_key/object_name/unit_name/source_code): ${source_key || "(ohne key)"}`,
      );
    }

    units.push({
      source_key,
      object_name,
      unit_name,
      unit_type: typeof value.unit_type === "string" ? value.unit_type : undefined,
      include_name:
        typeof value.include_name === "string" ? value.include_name : undefined,
      source_code,
    });
  }

  return units;
}

export function parseUnitAnalysesJsonl(
  text: string,
): Map<string, UnitAnalysisRecord> {
  const map = new Map<string, UnitAnalysisRecord>();
  if (!text.trim()) return map;

  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const parsed = unitAnalysisRecordSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      map.set(parsed.data.source_key, parsed.data);
    } catch {
      // skip corrupt line
    }
  }
  return map;
}

export function analysesToJsonl(
  analyses: Iterable<UnitAnalysisRecord>,
): string {
  const rows = [...analyses];
  if (rows.length === 0) return "";
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

export type AnalyzeCodeUnitResult =
  | {
      ok: true;
      record: UnitAnalysisRecord;
      skipped: boolean;
      cache: UnitAnalysisCacheDecision;
      deviationsLogged: boolean;
      evidenceMismatches: number;
    }
  | {
      ok: false;
      error: UnitAnalysisErrorRecord;
      cache?: UnitAnalysisCacheDecision;
    };

/**
 * Analyze one METHOD code unit via OpenAI structured output.
 * Post-validates evidence, enriches macros / deterministic facts.
 * Reuses cache when source_key + hashes + prompt + model + schema match.
 */
export async function analyzeCodeUnit(params: {
  unit: CodeUnitInput;
  existing?: UnitAnalysisRecord;
  provider?: OpenAIProvider;
  model?: string;
  promptVersion?: string;
  analysisSchemaVersion?: string;
  knownMacros?: Set<string>;
}): Promise<AnalyzeCodeUnitResult> {
  const promptVersion = params.promptVersion ?? UNIT_ANALYSIS_PROMPT_VERSION;
  const model = params.model ?? AI_CONFIG.chatModel;
  const analysisSchemaVersion =
    params.analysisSchemaVersion ?? UNIT_ANALYSIS_SCHEMA_VERSION;
  const contentHash = hashUnitContent(params.unit.source_code);
  const knownMacros = params.knownMacros ?? new Set<string>();

  const cache = evaluateUnitAnalysisCache({
    existing: params.existing,
    source_key: params.unit.source_key,
    contentHash,
    promptVersion,
    model,
    analysisSchemaVersion,
  });

  if (cache.hit && params.existing) {
    return {
      ok: true,
      record: withCacheMetadata(params.existing, analysisSchemaVersion),
      skipped: true,
      cache,
      deviationsLogged: false,
      evidenceMismatches: 0,
    };
  }

  const provider = params.provider ?? new OpenAIProvider();
  const deterministic = extractAbapArtifacts(params.unit.source_code);

  try {
    const modelOut = await provider.generateStructured({
      schema: unitAnalysisModelSchema,
      schemaName: "sap_code_unit_analysis_v4",
      system: buildUnitAnalysisSystemPrompt(),
      user: buildUnitAnalysisUserPrompt({
        className: params.unit.object_name,
        methodName: params.unit.unit_name,
        sourceKey: params.unit.source_key,
        includeName: params.unit.include_name,
        numberedCode: numberSourceLines(params.unit.source_code),
      }),
      model,
      timeoutMs: AI_CONFIG.analysisTimeoutMs,
    });

    const extraction_deviations = compareExtractions(modelOut, deterministic);

    const draft = {
      ...modelOut,
      source_key: params.unit.source_key,
      class_name: params.unit.object_name,
      method_name: params.unit.unit_name,
      model,
      model_version: model,
      prompt_version: promptVersion,
      content_hash: contentHash,
      source_hash: contentHash,
      analysis_schema_version: analysisSchemaVersion,
      deterministic,
      extraction_deviations,
    };

    const repaired = repairUnitAnalysisRecord({
      record: draft,
      sourceCode: params.unit.source_code,
    });

    const enriched = enrichUnitAnalysisRecord({
      record: {
        ...repaired.record,
        prompt_version: promptVersion,
        content_hash: contentHash,
        source_hash: contentHash,
        model,
        model_version: model,
        analysis_schema_version: analysisSchemaVersion,
      },
      sourceCode: params.unit.source_code,
      knownMacros,
    });

    return {
      ok: true,
      record: withCacheMetadata(enriched, analysisSchemaVersion),
      skipped: false,
      cache,
      deviationsLogged: enriched.extraction_deviations.length > 0,
      evidenceMismatches: repaired.evidenceMismatches,
    };
  } catch (error) {
    const message =
      error instanceof AIProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unbekannter Analysefehler";
    const category =
      error instanceof AIProviderError ? error.category : "unknown";

    return {
      ok: false,
      cache,
      error: {
        at: new Date().toISOString(),
        source_key: params.unit.source_key,
        class_name: params.unit.object_name,
        method_name: params.unit.unit_name,
        content_hash: contentHash,
        prompt_version: promptVersion,
        model,
        error: message,
        category,
      },
    };
  }
}

export { formatCacheDecisionLog };
