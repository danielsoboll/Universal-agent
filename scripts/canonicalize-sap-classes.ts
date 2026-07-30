/**
 * Local SAP class export → canonical JSONL (no OpenAI, no embeddings, no Supabase).
 * Run: npm run canonicalize:sap-classes
 *
 * Reads:  ${LOCAL_DATA_ROOT}/P01/raw/classes/*.jsonl
 * Writes: ${LOCAL_DATA_ROOT}/P01/canonical/classes/*
 *         ${LOCAL_DATA_ROOT}/P01/logs/*
 */
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import {
  canonicalizeSapClassExport,
  recordsToJsonl,
} from "../src/lib/ingest/sapClassCanonical";
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
    // required below via getLocalDataRoot
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function findClassExportFile(): { fileName: string; absolutePath: string; bytes: number } {
  const entries = listRawEntries(PROJECT_KEY, "classes").filter(
    (name) => !name.startsWith(".") && name.toLowerCase().endsWith(".jsonl"),
  );

  if (entries.length === 0) {
    fail(
      `Keine .jsonl-Datei unter raw/classes gefunden (${PROJECT_KEY}/raw/classes).`,
    );
  }

  const ranked = entries
    .map((fileName) => {
      const absolutePath = resolveRawPath(PROJECT_KEY, "classes", fileName);
      const st = statSync(absolutePath);
      return { fileName, absolutePath, bytes: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const chosen = ranked[0]!;
  return {
    fileName: chosen.fileName,
    absolutePath: chosen.absolutePath,
    bytes: chosen.bytes,
  };
}

function main() {
  loadEnvFile(".env.local");

  let root: string;
  try {
    root = getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  const source = findClassExportFile();
  if (!existsSync(source.absolutePath)) {
    fail(`Quelldatei fehlt: ${source.absolutePath}`);
  }

  const startedAt = new Date().toISOString();
  const buffer = readRawBuffer(PROJECT_KEY, "classes", source.fileName);
  const text = buffer.toString("utf8");

  const result = canonicalizeSapClassExport({
    text,
    sourceFileName: source.fileName,
    sourceBytes: source.bytes,
  });

  ensureWritableDir(PROJECT_KEY, "canonical", "classes");
  ensureWritableDir(PROJECT_KEY, "logs");

  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "classes/source_objects.jsonl",
    recordsToJsonl(result.sourceObjects),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "classes/source_fragments.jsonl",
    recordsToJsonl(result.sourceFragments),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "classes/code_units.jsonl",
    recordsToJsonl(result.codeUnits),
  );
  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "classes/relations.jsonl",
    recordsToJsonl(result.relations),
  );

  const report = {
    ok:
      result.stats.invalid === 0 && result.stats.key_collisions === 0,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    local_data_root: root,
    project_key: PROJECT_KEY,
    source: {
      relative: `raw/classes/${source.fileName}`,
      file_name: source.fileName,
      bytes: source.bytes,
    },
    outputs: {
      source_objects: "canonical/classes/source_objects.jsonl",
      source_fragments: "canonical/classes/source_fragments.jsonl",
      code_units: "canonical/classes/code_units.jsonl",
      relations: "canonical/classes/relations.jsonl",
      ingest_report: "canonical/classes/ingest_report.json",
      log: "logs/canonicalize-sap-classes.log",
    },
    stats: result.stats,
    issues: result.issues,
    notes: [
      "raw/ unverändert (nur gelesen)",
      "keine OpenAI-Aufrufe",
      "keine Embeddings",
      "kein Supabase",
      "source_fragment-Schlüssel: system_id|object_type|object_name|SOURCE_FRAGMENT|include_name",
    ],
  };

  writeGeneratedText(
    PROJECT_KEY,
    "canonical",
    "classes/ingest_report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  appendLogLine(
    PROJECT_KEY,
    "canonicalize-sap-classes.log",
    [
      `[${report.finished_at}] canonicalize sap classes`,
      `source=${source.fileName}`,
      `bytes=${source.bytes}`,
      `lines_total=${result.stats.lines_total}`,
      `valid=${result.stats.valid}`,
      `invalid=${result.stats.invalid}`,
      `classes=${result.stats.classes}`,
      `methods=${result.stats.methods}`,
      `fragments=${result.stats.fragments}`,
      `relations=${result.stats.relations}`,
      `duplicates=${result.stats.duplicates}`,
      `key_collisions=${result.stats.key_collisions}`,
    ].join(" "),
  );

  // End output: statistics only
  console.log(`Zeilen gesamt: ${result.stats.lines_total}`);
  console.log(`gültig: ${result.stats.valid}`);
  console.log(`ungültig: ${result.stats.invalid}`);
  console.log(`Klassen: ${result.stats.classes}`);
  console.log(`Methoden: ${result.stats.methods}`);
  console.log(`Fragmente: ${result.stats.fragments}`);
  console.log(`Relationen: ${result.stats.relations}`);
  console.log(`Duplikate: ${result.stats.duplicates}`);
  console.log(`Key-Kollisionen: ${result.stats.key_collisions}`);
}

main();
