/**
 * Deterministic links between code_units and control-table definitions/rows.
 * No OpenAI / embeddings / Supabase.
 *
 *   npm run link:code-control-tables
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { linkCodeUnitsToControlTables } from "../src/lib/analysis/codeTableLinkExtract";
import type {
  CanonicalTableDefinition,
  CanonicalTableRow,
} from "../src/lib/ingest/controlTables/model";
import { recordsToJsonl } from "../src/lib/ingest/controlTables/model";
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

function readJsonl<T>(absolutePath: string): T[] {
  if (!existsSync(absolutePath)) return [];
  return readFileSync(absolutePath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function main() {
  loadEnvFile(".env.local");
  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  const unitsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "classes/code_units.jsonl",
  );
  const defsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_definitions.jsonl",
  );
  const rowsPath = resolveWritablePath(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_rows.jsonl",
  );

  if (!existsSync(unitsPath)) fail(`code_units fehlen: ${unitsPath}`);
  if (!existsSync(defsPath)) {
    fail(`table_definitions fehlen — zuerst npm run canonicalize:control-tables`);
  }

  const codeUnits = readJsonl<Record<string, unknown>>(unitsPath)
    .filter((u) => String(u.unit_type ?? "").toUpperCase() === "METHOD")
    .map((u) => ({
      source_key: String(u.source_key ?? ""),
      unit_name: String(u.unit_name ?? ""),
      source_code: String(u.source_code ?? ""),
    }))
    .filter((u) => u.source_key && u.source_code);

  const definitions = readJsonl<CanonicalTableDefinition>(defsPath);
  const rows = readJsonl<CanonicalTableRow>(rowsPath);

  const startedAt = new Date().toISOString();
  const result = linkCodeUnitsToControlTables({
    codeUnits,
    definitions,
    rows,
  });

  ensureWritableDir(PROJECT_KEY, "canonical", "relations");
  ensureWritableDir(PROJECT_KEY, "logs");

  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "relations/code_table_links.jsonl",
    recordsToJsonl(result.relations),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "code_table_accesses.jsonl",
    result.accesses.length
      ? `${result.accesses.map((a) => JSON.stringify(a)).join("\n")}\n`
      : "",
  );

  const report = {
    at: startedAt,
    stats: result.stats,
    examples: result.examples,
    geaenderte_dateien: [
      "src/lib/analysis/codeTableLinkExtract.ts",
      "scripts/link-code-control-tables.ts",
      "P01/canonical/relations/code_table_links.jsonl",
      "P01/logs/code_table_accesses.jsonl",
      "P01/logs/code_table_link_report.json",
    ],
  };

  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "code_table_link_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  appendLogLine(
    PROJECT_KEY,
    "link-code-control-tables.log",
    `[${startedAt}] units_with_access=${result.stats.code_units_with_table_access} resolved=${result.stats.resolved_rows} candidates=${result.stats.candidate_resolutions} dynamic=${result.stats.unresolved_dynamic} relations=${result.stats.relations}`,
  );

  console.log(`Code Units gescannt: ${result.stats.code_units_scanned}`);
  console.log(
    `Code Units mit Tabellenzugriff: ${result.stats.code_units_with_table_access}`,
  );
  console.log(`Zugriffe: ${result.stats.accesses} (R=${result.stats.reads}/W=${result.stats.writes})`);
  console.log(`direkt aufgelöste Tabellenzeilen: ${result.stats.resolved_rows}`);
  console.log(`Kandidatenauflösungen: ${result.stats.candidate_resolutions}`);
  console.log(`nicht auflösbare dynamische Zugriffe: ${result.stats.unresolved_dynamic}`);
  console.log(`Relationen: ${result.stats.relations}`);
  console.log("Beispiele:");
  for (const ex of result.examples) {
    console.log(
      `- ${ex.method_name} → ${ex.table_name} [${ex.relation_type}]`,
    );
    console.log(`  code: ${ex.evidence_from_code.slice(0, 120)}`);
    console.log(`  table: ${ex.evidence_from_table.slice(0, 120)}`);
  }
}

main();
