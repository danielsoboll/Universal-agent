/**
 * Canonicalize SAP control/customizing table exports (no OpenAI / embeddings / Supabase).
 *
 * Reads:  ${LOCAL_DATA_ROOT}/P01/raw/control-tables/{definitions,contents}/*.jsonl
 * Writes: ${LOCAL_DATA_ROOT}/P01/canonical/control-tables/*
 *
 *   npm run canonicalize:control-tables
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { canonicalizeControlTableSources } from "../src/lib/ingest/controlTables/canonicalize";
import { recordsToJsonl } from "../src/lib/ingest/controlTables/model";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  appendLogLine,
  ensureWritableDir,
  listRawEntries,
  readRawBuffer,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveRawPath } from "../src/lib/localData/paths";
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

function listJsonl(subdir: string): Array<{ fileName: string; absolutePath: string; bytes: number }> {
  const entries = listRawEntries(PROJECT_KEY, "control-tables", subdir).filter(
    (name) => !name.startsWith(".") && name.toLowerCase().endsWith(".jsonl"),
  );
  return entries
    .map((fileName) => {
      const absolutePath = resolveRawPath(
        PROJECT_KEY,
        "control-tables",
        subdir,
        fileName,
      );
      return {
        fileName: `${subdir}/${fileName}`,
        absolutePath,
        bytes: statSync(absolutePath).size,
      };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function fileSha256(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

function main() {
  loadEnvFile(".env.local");
  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  const definitionFiles = listJsonl("definitions");
  const contentFiles = listJsonl("contents");
  if (definitionFiles.length === 0 && contentFiles.length === 0) {
    fail("Keine JSONL unter raw/control-tables/definitions|contents");
  }

  const rawHashesBefore = [...definitionFiles, ...contentFiles].map((f) => ({
    file: f.fileName,
    sha256: fileSha256(f.absolutePath),
  }));

  const sources = [...definitionFiles, ...contentFiles].map((f) => {
    const parts = f.fileName.split("/");
    const sub = parts[0]!;
    const name = parts.slice(1).join("/");
    const buffer = readRawBuffer(PROJECT_KEY, "control-tables", sub, name);
    return {
      text: buffer.toString("utf8"),
      sourceFile: f.fileName,
    };
  });

  const startedAt = new Date().toISOString();
  const result = canonicalizeControlTableSources(sources);

  const rawHashesAfter = [...definitionFiles, ...contentFiles].map((f) => ({
    file: f.fileName,
    sha256: fileSha256(f.absolutePath),
  }));
  const rawUnchanged = rawHashesBefore.every(
    (b, i) => b.sha256 === rawHashesAfter[i]?.sha256,
  );

  ensureWritableDir(PROJECT_KEY, "canonical", "control-tables");
  ensureWritableDir(PROJECT_KEY, "logs");

  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_definitions.jsonl",
    recordsToJsonl(result.definitions),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_classifications.jsonl",
    recordsToJsonl(result.classifications),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_rows.jsonl",
    recordsToJsonl(result.rows),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_entities.jsonl",
    recordsToJsonl(result.entities),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "control-tables/table_relations.jsonl",
    recordsToJsonl(result.relations),
  );

  const report = {
    at: startedAt,
    project: PROJECT_KEY,
    sources: [...definitionFiles, ...contentFiles].map((f) => ({
      file: f.fileName,
      bytes: f.bytes,
    })),
    stats: result.stats,
    raw_files_unchanged: rawUnchanged,
    issue_count: result.issues.length,
    issues_sample: result.issues.slice(0, 30),
  };

  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "control-tables/ingest_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "control-tables-ingest-issues.jsonl",
    result.issues.length
      ? `${result.issues.map((i) => JSON.stringify(i)).join("\n")}\n`
      : "",
  );

  appendLogLine(
    PROJECT_KEY,
    "canonicalize-control-tables.log",
    `[${startedAt}] defs=${result.stats.definitions} class=${result.stats.classifications} rows=${result.stats.rows} entities=${result.stats.entities} relations=${result.stats.relations} dupes=${result.stats.duplicates} collisions=${result.stats.key_collisions} raw_ok=${rawUnchanged}`,
  );

  console.log(`Definitionen: ${result.stats.definitions}`);
  console.log(`Klassifikationen: ${result.stats.classifications}`);
  console.log(`Tabellenzeilen: ${result.stats.rows}`);
  console.log(`eindeutige Tabellen: ${result.stats.unique_tables}`);
  console.log(`Tabellen mit Inhalt: ${result.stats.tables_with_rows}`);
  console.log(`Entities: ${result.stats.entities}`);
  console.log(`Relationen: ${result.stats.relations}`);
  console.log(`Duplikate: ${result.stats.duplicates}`);
  console.log(`Key Collisions: ${result.stats.key_collisions}`);
  console.log(`fehlende Definitionen: ${result.stats.missing_definitions}`);
  console.log(`Raw unverändert: ${rawUnchanged}`);
  console.log(`Issues: ${result.issues.length}`);
}

main();
