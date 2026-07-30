/**
 * Repair/validate stored unit_analyses against canonical code_units.
 * No OpenAI, no embeddings, no Supabase.
 *
 *   npm run repair:sap-unit-analyses
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { analysesToJsonl } from "../src/lib/analysis/analyzeCodeUnits";
import { repairAllUnitAnalyses } from "../src/lib/analysis/repairUnitAnalyses";
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
  if (!existsSync(analysesPath)) fail(`Fehlt: ${analysesPath}`);
  if (!existsSync(unitsPath)) fail(`Fehlt: ${unitsPath}`);

  const analyses = readFileSync(analysesPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const codeUnitsByKey = new Map<
    string,
    { source_code: string; unit_name?: string }
  >();
  for (const line of readFileSync(unitsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const u = JSON.parse(line) as Record<string, unknown>;
    codeUnitsByKey.set(String(u.source_key), {
      source_code: String(u.source_code ?? ""),
      unit_name: typeof u.unit_name === "string" ? u.unit_name : undefined,
    });
  }

  const bundle = repairAllUnitAnalyses({ analyses, codeUnitsByKey });

  // Keep canonical method order
  const order = [...codeUnitsByKey.keys()];
  const byKey = new Map(bundle.records.map((r) => [r.source_key, r]));
  const ordered = order
    .map((k) => byKey.get(k))
    .filter((r): r is NonNullable<typeof r> => r != null);

  ensureWritableDir(PROJECT_KEY, "analyses", "classes");
  ensureWritableDir(PROJECT_KEY, "logs");

  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "classes/unit_analyses.jsonl",
    analysesToJsonl(ordered),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "classes/needs_reanalysis.json",
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        count: bundle.report.needs_reanalysis_keys.length,
        source_keys: bundle.report.needs_reanalysis_keys,
      },
      null,
      2,
    )}\n`,
  );
  writeGeneratedText(
    PROJECT_KEY,
    "analyses",
    "classes/repair_report.json",
    `${JSON.stringify(bundle.report, null, 2)}\n`,
  );

  if (bundle.mismatches.length > 0) {
    writeGeneratedText(
      PROJECT_KEY,
      "logs",
      "evidence_mismatches.jsonl",
      `${bundle.mismatches.map((m) => JSON.stringify(m)).join("\n")}\n`,
    );
  }

  appendLogLine(
    PROJECT_KEY,
    "repair-sap-unit-analyses.log",
    `[${new Date().toISOString()}] repair done methods=${bundle.report.methods_total} needs_reanalysis=${bundle.report.methods_needs_reanalysis} evidence_valid=${bundle.report.evidence_valid} corrigible=${bundle.report.evidence_corrigible} mismatches=${bundle.report.evidence_mismatches}`,
  );

  console.log(`gültige Evidence: ${bundle.report.evidence_valid}`);
  console.log(`korrigierbare Evidence: ${bundle.report.evidence_corrigible}`);
  console.log(`Evidence-Mismatches: ${bundle.report.evidence_mismatches}`);
  console.log(
    `echte externe Schnittstellen: ${bundle.report.real_external_interfaces}`,
  );
  console.log(
    `verworfene Pseudo-Schnittstellen: ${bundle.report.discarded_pseudo_interfaces}`,
  );
  console.log(
    `bereinigte Extraktionsabweichungen: ${bundle.report.extraction_deviations_before} → ${bundle.report.extraction_deviations_after}`,
  );
  console.log(
    `Methoden für Re-Analyse (v3): ${bundle.report.methods_needs_reanalysis}`,
  );
}

main();
