/**
 * Structured OpenAI analysis for canonical SAP class code_units.
 * No embeddings, no Supabase writes.
 *
 * Pilot:
 *   npm run analyze:sap-code-units -- --limit 3
 *
 * Full class:
 *   npm run analyze:sap-code-units -- --limit 39
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  analysesToJsonl,
  analyzeCodeUnit,
  parseCodeUnitsJsonl,
  parseUnitAnalysesJsonl,
} from "../src/lib/analysis/analyzeCodeUnits";
import { loadKnownMacrosFromFragments } from "../src/lib/analysis/macroExtract";
import type { UnitAnalysisRecord } from "../src/lib/analysis/unitAnalysisSchema";
import { UNIT_ANALYSIS_PROMPT_VERSION } from "../src/lib/analysis/unitAnalysisSchema";
import { AI_CONFIG } from "../src/lib/ai/config";
import { OpenAIProvider } from "../src/lib/ai/openaiProvider";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  appendLogLine,
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";

const PROJECT_KEY = "P01";
const CODE_UNITS_REL = "classes/code_units.jsonl";
const ANALYSES_REL = "classes/unit_analyses.jsonl";
const ERRORS_REL = "unit_analysis_errors.jsonl";
const DEVIATIONS_REL = "unit_analysis_deviations.jsonl";

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q)) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function loadEnvFile(filename: string) {
  try {
    const text = readFileSync(path.resolve(process.cwd(), filename), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ")
        ? line.slice("export ".length).trim()
        : line;
      const eq = normalized.indexOf("=");
      if (eq <= 0) continue;
      const key = normalized.slice(0, eq).trim();
      const value = stripQuotes(normalized.slice(eq + 1));
      if (!key) continue;
      if (!process.env[key] || process.env[key]?.trim() === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // validated later
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseLimit(argv: string[]): number | null {
  const eq = argv.find((a) => a.startsWith("--limit="));
  if (eq) {
    const n = Number(eq.slice("--limit=".length));
    if (!Number.isFinite(n) || n < 1) fail(`Ungültiges --limit: ${eq}`);
    return Math.floor(n);
  }
  const idx = argv.indexOf("--limit");
  if (idx >= 0) {
    const n = Number(argv[idx + 1]);
    if (!Number.isFinite(n) || n < 1) {
      fail(`Ungültiges --limit: ${argv[idx + 1] ?? "(fehlt)"}`);
    }
    return Math.floor(n);
  }
  return null;
}

function wantsOnlyNeedsReanalysis(argv: string[]): boolean {
  return argv.includes("--only-needs-reanalysis");
}

function readNeedsReanalysisKeys(): string[] {
  const absolute = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    "classes/needs_reanalysis.json",
  );
  if (!existsSync(absolute)) {
    fail(
      `needs_reanalysis.json fehlt (${absolute}). Zuerst npm run repair:sap-unit-analyses.`,
    );
  }
  const parsed = JSON.parse(readFileSync(absolute, "utf8")) as {
    source_keys?: string[];
  };
  return Array.isArray(parsed.source_keys) ? parsed.source_keys : [];
}

function readExistingAnalyses(): Map<string, UnitAnalysisRecord> {
  const absolute = resolveWritablePath(PROJECT_KEY, "analyses", ANALYSES_REL);
  if (!existsSync(absolute)) return new Map();
  return parseUnitAnalysesJsonl(readFileSync(absolute, "utf8"));
}

function readCanonicalCodeUnitsText(): string {
  const absolute = resolveWritablePath(PROJECT_KEY, "canonical", CODE_UNITS_REL);
  if (!existsSync(absolute)) {
    fail(
      `Canonical code_units fehlen: ${absolute}. Zuerst npm run canonicalize:sap-classes ausführen.`,
    );
  }
  return readFileSync(absolute, "utf8");
}

function appendJsonl(relativeLogFile: string, lines: string[]) {
  if (lines.length === 0) return;
  const absolute = resolveWritablePath(PROJECT_KEY, "logs", relativeLogFile);
  const prev = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    relativeLogFile,
    `${prev}${lines.join("\n")}\n`,
  );
}

function buildStats(records: UnitAnalysisRecord[]) {
  const tables = new Set<string>();
  const interfaces = new Set<string>();
  let facts = 0;
  let inferences = 0;
  let hardcodings = 0;
  let confidenceSum = 0;

  for (const r of records) {
    confidenceSum += r.confidence;
    facts += r.facts.length;
    inferences += r.inferences.length;
    hardcodings += r.hardcoded_values.length;
    for (const t of r.tables_read) tables.add(t.toUpperCase());
    for (const t of r.tables_written) tables.add(t.toUpperCase());
    for (const i of r.external_interfaces) interfaces.add(i.toUpperCase());
  }

  return {
    avg_confidence:
      records.length === 0
        ? 0
        : Number((confidenceSum / records.length).toFixed(3)),
    facts,
    inferences,
    hardcodings,
    tables: tables.size,
    external_interfaces: interfaces.size,
  };
}

async function main() {
  loadEnvFile(".env.local");
  const argv = process.argv.slice(2);
  const onlyNeeds = wantsOnlyNeedsReanalysis(argv);
  const limit = parseLimit(argv);

  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    fail("OPENAI_API_KEY fehlt in .env.local — Analyse abgebrochen.");
  }

  const units = parseCodeUnitsJsonl(readCanonicalCodeUnitsText());
  if (units.length === 0) {
    fail("Keine METHOD code_units in canonical/classes/code_units.jsonl.");
  }

  let selected = units;
  if (onlyNeeds) {
    const keys = new Set(readNeedsReanalysisKeys());
    selected = units.filter((u) => keys.has(u.source_key));
    if (selected.length === 0) {
      console.log("analysiert: 0");
      console.log("übersprungen: 0");
      console.log("Fehler: 0");
      console.log("Hinweis: needs_reanalysis ist leer — nichts zu tun.");
      return;
    }
  } else {
    const effectiveLimit = limit ?? 3;
    selected = units.slice(0, effectiveLimit);
  }

  const existing = readExistingAnalyses();
  const provider = new OpenAIProvider();

  const fragmentsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "classes/source_fragments.jsonl",
  );
  const knownMacros = existsSync(fragmentsPath)
    ? loadKnownMacrosFromFragments(
        readFileSync(fragmentsPath, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .map((f) => ({
            fragment_type: String(f.fragment_type ?? ""),
            unit_type: String(f.unit_type ?? ""),
            source_code: String(f.source_code ?? ""),
          })),
      )
    : new Set<string>();

  ensureWritableDir(PROJECT_KEY, "analyses", "classes");
  ensureWritableDir(PROJECT_KEY, "logs");

  const startedAt = new Date().toISOString();
  let analyzed = 0;
  let skipped = 0;
  let failed = 0;
  let deviationUnits = 0;
  const errorLines: string[] = [];
  const deviationLines: string[] = [];
  const mismatchLines: string[] = [];

  appendLogLine(
    PROJECT_KEY,
    "analyze-sap-code-units.log",
    `[${startedAt}] start only_needs=${onlyNeeds} selected=${selected.length} total_methods=${units.length} prompt=${UNIT_ANALYSIS_PROMPT_VERSION} model=${AI_CONFIG.chatModel} known_macros=${knownMacros.size}`,
  );

  for (const unit of selected) {
    const prior = existing.get(unit.source_key);
    const result = await analyzeCodeUnit({
      unit,
      // Force re-analysis for needs_reanalysis list even if hashes match
      existing: onlyNeeds
        ? prior
          ? { ...prior, needs_reanalysis: true, prompt_version: "force-reanalyze" }
          : undefined
        : prior,
      provider,
      knownMacros,
    });

    if (!result.ok) {
      failed += 1;
      errorLines.push(JSON.stringify(result.error));
      appendLogLine(
        PROJECT_KEY,
        "analyze-sap-code-units.log",
        `[${result.error.at}] FAIL ${unit.source_key} ${result.error.error}`,
      );
      continue;
    }

    existing.set(result.record.source_key, result.record);

    if (result.skipped) {
      skipped += 1;
      appendLogLine(
        PROJECT_KEY,
        "analyze-sap-code-units.log",
        `[${new Date().toISOString()}] SKIP ${unit.source_key}`,
      );
    } else {
      analyzed += 1;
      if (analyzed % 10 === 0 || analyzed === 1) {
        const checkpoint = units
          .map((u) => existing.get(u.source_key))
          .filter((r): r is UnitAnalysisRecord => r != null);
        writeGeneratedText(
          PROJECT_KEY,
          "analyses",
          ANALYSES_REL,
          analysesToJsonl(checkpoint),
        );
        appendLogLine(
          PROJECT_KEY,
          "analyze-sap-code-units.log",
          `[${new Date().toISOString()}] CHECKPOINT analyzed=${analyzed} stored=${checkpoint.length}`,
        );
      }
      appendLogLine(
        PROJECT_KEY,
        "analyze-sap-code-units.log",
        `[${new Date().toISOString()}] OK ${unit.source_key} confidence=${result.record.confidence} deviations=${result.record.extraction_deviations.length} evidence_mismatches=${result.evidenceMismatches}`,
      );

      if (result.evidenceMismatches > 0) {
        mismatchLines.push(
          JSON.stringify({
            at: new Date().toISOString(),
            code: "EVIDENCE_MISMATCH",
            source_key: result.record.source_key,
            method_name: result.record.method_name,
            count: result.evidenceMismatches,
            prompt_version: result.record.prompt_version,
          }),
        );
      }

      if (result.record.extraction_deviations.length > 0) {
        deviationUnits += 1;
        deviationLines.push(
          JSON.stringify({
            at: new Date().toISOString(),
            source_key: result.record.source_key,
            method_name: result.record.method_name,
            prompt_version: result.record.prompt_version,
            deviations: result.record.extraction_deviations,
            deterministic: result.record.deterministic,
            ai: {
              tables_read: result.record.tables_read,
              tables_written: result.record.tables_written,
              called_functions: result.record.called_functions,
              called_methods: result.record.called_methods,
            },
          }),
        );
      }
    }
  }

  const ordered = units
    .map((u) => existing.get(u.source_key))
    .filter((r): r is UnitAnalysisRecord => r != null);

  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    ANALYSES_REL,
    analysesToJsonl(ordered),
  );

  // Refresh needs_reanalysis after selective v3 run
  const stillNeeded = ordered
    .filter((r) => r.needs_reanalysis)
    .map((r) => r.source_key);
  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "classes/needs_reanalysis.json",
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        count: stillNeeded.length,
        source_keys: stillNeeded,
      },
      null,
      2,
    )}\n`,
  );

  appendJsonl(ERRORS_REL, errorLines);
  appendJsonl(DEVIATIONS_REL, deviationLines);
  appendJsonl("evidence_mismatches.jsonl", mismatchLines);

  const stats = buildStats(ordered);
  const finishedAt = new Date().toISOString();
  appendLogLine(
    PROJECT_KEY,
    "analyze-sap-code-units.log",
    `[${finishedAt}] done analyzed=${analyzed} skipped=${skipped} failed=${failed} deviation_units=${deviationUnits} stored=${ordered.length}`,
  );

  console.log(`analysiert: ${analyzed}`);
  console.log(`übersprungen: ${skipped}`);
  console.log(`Fehler: ${failed}`);
  console.log(`durchschnittliche Confidence: ${stats.avg_confidence}`);
  console.log(`Anzahl Facts: ${stats.facts}`);
  console.log(`Anzahl Inferences: ${stats.inferences}`);
  console.log(`Anzahl Hardcodings: ${stats.hardcodings}`);
  console.log(`Anzahl Tabellen: ${stats.tables}`);
  console.log(`Anzahl externe Schnittstellen: ${stats.external_interfaces}`);
  console.log(`noch needs_reanalysis: ${stillNeeded.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
