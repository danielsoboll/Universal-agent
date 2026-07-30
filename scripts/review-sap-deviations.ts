/**
 * Review remaining extraction deviations from the deviations log,
 * classify each atomic entry, refresh deterministic comparisons after parser fixes.
 * No OpenAI / embeddings / full re-analysis.
 *
 *   npm run review:sap-deviations
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { extractAbapArtifacts } from "../src/lib/analysis/abapExtract";
import { analysesToJsonl } from "../src/lib/analysis/analyzeCodeUnits";
import {
  expandAndClassifyDeviations,
  type DeviationReviewEntry,
} from "../src/lib/analysis/deviationReview";
import { compareExtractions } from "../src/lib/analysis/extractionCompare";
import {
  unitAnalysisRecordSchema,
  type UnitAnalysisRecord,
} from "../src/lib/analysis/unitAnalysisSchema";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  appendLogLine,
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";

const PROJECT_KEY = "P01";

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q)) return v.slice(1, -1);
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
    // later
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function countAtomic(
  deviations: Array<{
    only_in_ai: string[];
    only_in_deterministic: string[];
  }>,
): number {
  let n = 0;
  for (const d of deviations) {
    n += d.only_in_ai.length + d.only_in_deterministic.length;
  }
  return n;
}

type LogDeviation = {
  field:
    | "tables_read"
    | "tables_written"
    | "called_functions"
    | "called_methods";
  only_in_ai: string[];
  only_in_deterministic: string[];
};

type LogRow = {
  source_key: string;
  method_name?: string;
  deviations: LogDeviation[];
  ai?: {
    tables_read?: string[];
    tables_written?: string[];
    called_functions?: string[];
    called_methods?: string[];
  };
};

function main() {
  loadEnvFile(".env.local");
  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  const analysesPath = resolveWritablePath(
    PROJECT_KEY,
    "analyses",
    "classes/unit_analyses.jsonl",
  );
  const unitsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "classes/code_units.jsonl",
  );
  const logPath = resolveWritablePath(
    PROJECT_KEY,
    "logs",
    "unit_analysis_deviations.jsonl",
  );
  if (!existsSync(analysesPath) || !existsSync(unitsPath) || !existsSync(logPath)) {
    fail("analyses/code_units/deviations-log fehlen");
  }

  const logRows = readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogRow);
  const selectedLog = logRows.slice(-16);
  const beforeAtomicFromLog = selectedLog.reduce(
    (sum, row) => sum + countAtomic(row.deviations ?? []),
    0,
  );

  const analysesRaw = readFileSync(analysesPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const analysisByKey = new Map(
    analysesRaw.map((r) => [String(r.source_key), r]),
  );

  const unitsByKey = new Map<string, string>();
  for (const line of readFileSync(unitsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const u = JSON.parse(line) as Record<string, unknown>;
    unitsByKey.set(String(u.source_key), String(u.source_code ?? ""));
  }

  const reviews: DeviationReviewEntry[] = [];

  for (const row of selectedLog) {
    const key = String(row.source_key ?? "");
    const code = unitsByKey.get(key);
    const stored = analysisByKey.get(key);
    if (!code || !stored) continue;

    const analysis = {
      source_key: key,
      class_name: String(stored.class_name ?? ""),
      method_name: String(
        stored.method_name ?? row.method_name ?? "",
      ),
      tables_read:
        row.ai?.tables_read ??
        (Array.isArray(stored.tables_read)
          ? (stored.tables_read as string[])
          : []),
      tables_written:
        row.ai?.tables_written ??
        (Array.isArray(stored.tables_written)
          ? (stored.tables_written as string[])
          : []),
      called_functions:
        row.ai?.called_functions ??
        (Array.isArray(stored.called_functions)
          ? (stored.called_functions as string[])
          : []),
      called_methods:
        row.ai?.called_methods ??
        (Array.isArray(stored.called_methods)
          ? (stored.called_methods as string[])
          : []),
    };

    reviews.push(
      ...expandAndClassifyDeviations({
        analysis,
        sourceCode: code,
        deviations: row.deviations ?? [],
      }),
    );
  }

  // Refresh all analyses with fixed extractor (no AI changes)
  const refreshed: UnitAnalysisRecord[] = [];
  let afterAtomic = 0;
  for (const raw of analysesRaw) {
    const key = String(raw.source_key);
    const code = unitsByKey.get(key) ?? "";
    const deterministic = extractAbapArtifacts(code);
    const extraction_deviations = compareExtractions(
      {
        tables_read: Array.isArray(raw.tables_read)
          ? (raw.tables_read as string[])
          : [],
        tables_written: Array.isArray(raw.tables_written)
          ? (raw.tables_written as string[])
          : [],
        called_functions: Array.isArray(raw.called_functions)
          ? (raw.called_functions as string[])
          : [],
        called_methods: Array.isArray(raw.called_methods)
          ? (raw.called_methods as string[])
          : [],
      },
      deterministic,
    );
    afterAtomic += countAtomic(extraction_deviations);
    refreshed.push(
      unitAnalysisRecordSchema.parse({
        ...raw,
        deterministic,
        extraction_deviations,
      }),
    );
  }

  const byCat: Record<string, number> = {};
  for (const r of reviews) {
    byCat[r.classification] = (byCat[r.classification] ?? 0) + 1;
  }

  const remainingReal = reviews.filter((r) =>
    [
      "REAL_AI_ADDITION",
      "REAL_DETERMINISTIC_ADDITION",
      "AI_FALSE_POSITIVE",
      "AMBIGUOUS",
    ].includes(r.classification),
  );

  // After fix: remaining real = post-refresh deviations that are not NORMALIZATION_ONLY / PARSER_FALSE_POSITIVE
  const afterReviews: DeviationReviewEntry[] = [];
  for (const r of refreshed) {
    if (r.extraction_deviations.length === 0) continue;
    const code = unitsByKey.get(r.source_key) ?? "";
    afterReviews.push(
      ...expandAndClassifyDeviations({
        analysis: r,
        sourceCode: code,
        deviations: r.extraction_deviations,
      }),
    );
  }
  const afterReal = afterReviews.filter((r) =>
    [
      "REAL_AI_ADDITION",
      "REAL_DETERMINISTIC_ADDITION",
      "AI_FALSE_POSITIVE",
      "AMBIGUOUS",
    ].includes(r.classification),
  );

  const recommended = [
    ...new Set(
      [...reviews, ...afterReviews]
        .filter(
          (r) =>
            r.requires_fix || r.classification === "PARSER_FALSE_POSITIVE",
        )
        .map((r) => r.recommended_action),
    ),
  ];

  const report = {
    at: new Date().toISOString(),
    scope: {
      log_entries_reviewed: selectedLog.length,
      atomic_entries_reviewed: reviews.length,
      methods: [...new Set(reviews.map((r) => r.method_name))].sort(),
    },
    counts_by_category: byCat,
    echte_parserfehler: byCat.PARSER_FALSE_POSITIVE ?? 0,
    echte_ki_fehler: byCat.AI_FALSE_POSITIVE ?? 0,
    reine_normalisierungsunterschiede: byCat.NORMALIZATION_ONLY ?? 0,
    sinnvolle_ki_ergaenzungen: byCat.REAL_AI_ADDITION ?? 0,
    echte_deterministic_ergaenzungen: byCat.REAL_DETERMINISTIC_ADDITION ?? 0,
    ambiguous: byCat.AMBIGUOUS ?? 0,
    betroffene_methoden: [...new Set(reviews.map((r) => r.method_name))].sort(),
    konkrete_empfohlene_korrekturen: recommended,
    abweichungen_vorher: beforeAtomicFromLog,
    abweichungen_nachher: afterAtomic,
    verbleibende_echte_unterschiede: afterReal.length,
    verbleibende_echte_nach_kategorie: afterReal.reduce<Record<string, number>>(
      (acc, r) => {
        acc[r.classification] = (acc[r.classification] ?? 0) + 1;
        return acc;
      },
      {},
    ),
    geaenderte_dateien: [
      "src/lib/analysis/abapExtract.ts",
      "src/lib/analysis/deviationReview.ts",
      "scripts/review-sap-deviations.ts",
      "package.json",
      `${PROJECT_KEY}/analyses/classes/unit_analyses.jsonl`,
      `${PROJECT_KEY}/logs/unit_analysis_deviation_review.jsonl`,
      `${PROJECT_KEY}/logs/unit_analysis_deviation_review_report.json`,
      `${PROJECT_KEY}/logs/unit_analysis_deviations.jsonl`,
    ],
  };

  ensureWritableDir(PROJECT_KEY, "logs");
  ensureWritableDir(PROJECT_KEY, "analyses", "classes");

  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "unit_analysis_deviation_review.jsonl",
    `${reviews.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "unit_analysis_deviation_review_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const order = [...unitsByKey.keys()];
  const byKey = new Map(refreshed.map((r) => [r.source_key, r]));
  const ordered = order
    .map((k) => byKey.get(k))
    .filter((r): r is UnitAnalysisRecord => r != null);

  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "classes/unit_analyses.jsonl",
    analysesToJsonl(ordered),
  );

  const freshDevLines: string[] = [];
  for (const r of ordered) {
    if (r.extraction_deviations.length === 0) continue;
    freshDevLines.push(
      JSON.stringify({
        at: new Date().toISOString(),
        source_key: r.source_key,
        method_name: r.method_name,
        prompt_version: r.prompt_version,
        deviations: r.extraction_deviations,
        deterministic: r.deterministic,
        ai: {
          tables_read: r.tables_read,
          tables_written: r.tables_written,
          called_functions: r.called_functions,
          called_methods: r.called_methods,
        },
      }),
    );
  }
  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "unit_analysis_deviations.jsonl",
    freshDevLines.length ? `${freshDevLines.join("\n")}\n` : "",
  );

  appendLogLine(
    PROJECT_KEY,
    "review-sap-deviations.log",
    `[${report.at}] before=${beforeAtomicFromLog} after=${afterAtomic} remaining_real=${afterReal.length}`,
  );

  console.log(`Abweichungen vorher: ${beforeAtomicFromLog}`);
  console.log(`Abweichungen nachher: ${afterAtomic}`);
  console.log(`verbleibende echte Unterschiede: ${afterReal.length}`);
  console.log("geänderte Dateien:");
  for (const f of report.geaenderte_dateien) console.log(`- ${f}`);
}

main();
