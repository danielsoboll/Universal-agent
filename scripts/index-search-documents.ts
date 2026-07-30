/**
 * Build generic SearchDocuments from canonical code units + unit analyses.
 * First knowledge-unit type: code_unit. No Supabase / embeddings / chat.
 *
 *   npm run index:search-documents
 */
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { parseUnitAnalysesJsonl } from "../src/lib/analysis/analyzeCodeUnits";
import { draftFromCodeUnitAnalysis } from "../src/lib/search/adapters/codeUnitAnalysis";
import {
  indexSearchDocuments,
  searchDocumentsToJsonl,
} from "../src/lib/search/indexSearchDocuments";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  appendLogLine,
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";

const PROJECT_KEY = "P01";
const OUT_REL = "classes/search_documents.jsonl";

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

function hashSourceCode(sourceCode: string): string {
  return createHash("sha256").update(sourceCode, "utf8").digest("hex");
}

function parseCodeUnitRefs(text: string) {
  const map = new Map<
    string,
    {
      source_key: string;
      system_id?: string;
      object_type?: string;
      object_name?: string;
      unit_type?: string;
      unit_name?: string;
      include_name?: string;
      language?: string;
      line_count?: number;
      content_hash?: string;
    }
  >();

  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (String(value.record_type ?? "code_unit") !== "code_unit") continue;
    const source_key = String(value.source_key ?? "").trim();
    if (!source_key) continue;
    const source_code =
      typeof value.source_code === "string" ? value.source_code : "";
    map.set(source_key, {
      source_key,
      system_id:
        typeof value.system_id === "string" ? value.system_id : undefined,
      object_type:
        typeof value.object_type === "string" ? value.object_type : undefined,
      object_name:
        typeof value.object_name === "string" ? value.object_name : undefined,
      unit_type:
        typeof value.unit_type === "string" ? value.unit_type : undefined,
      unit_name:
        typeof value.unit_name === "string" ? value.unit_name : undefined,
      include_name:
        typeof value.include_name === "string" ? value.include_name : undefined,
      language: typeof value.language === "string" ? value.language : undefined,
      line_count:
        typeof value.line_count === "number" ? value.line_count : undefined,
      content_hash: source_code ? hashSourceCode(source_code) : undefined,
    });
  }
  return map;
}

function searchTextStats(texts: string[]) {
  const lengths = texts.map((t) => t.length);
  if (lengths.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0 };
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const sum = lengths.reduce((s, n) => s + n, 0);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return {
    count: lengths.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: Math.round(sum / lengths.length),
    p50: pct(50),
    p90: pct(90),
  };
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
  const outPathRel = OUT_REL;
  const existingPath = resolveWritablePath(
    PROJECT_KEY,
    "indexes",
    outPathRel,
  );

  if (!existsSync(analysesPath)) {
    fail(`Analysen fehlen: ${analysesPath}`);
  }
  if (!existsSync(unitsPath)) {
    fail(`Canonical code_units fehlen: ${unitsPath}`);
  }

  const analyses = [...parseUnitAnalysesJsonl(readFileSync(analysesPath, "utf8")).values()];
  const units = parseCodeUnitRefs(readFileSync(unitsPath, "utf8"));
  const existingJsonl = existsSync(existingPath)
    ? readFileSync(existingPath, "utf8")
    : "";

  const drafts = analyses.map((analysis) =>
    draftFromCodeUnitAnalysis({
      analysis,
      unit: units.get(analysis.source_key) ?? null,
    }),
  );

  const now = new Date().toISOString();
  const result = indexSearchDocuments({
    drafts,
    existingJsonl,
    now,
  });

  ensureWritableDir(PROJECT_KEY, "indexes", "classes");
  writeGeneratedText(
    PROJECT_KEY,
    "indexes",
    outPathRel,
    searchDocumentsToJsonl(result.documents),
  );

  const stats = searchTextStats(result.documents.map((d) => d.search_text));
  const examples = result.documents.slice(0, 3).map((d) => ({
    search_document_id: d.search_document_id,
    source_key: d.source_key,
    title: d.title,
    knowledge_unit_type: d.knowledge_unit_type,
    confidence: d.confidence,
    content_hash: d.content_hash,
    search_text_length: d.search_text.length,
    search_text_preview: d.search_text.slice(0, 400),
    macro_calls: d.macro_calls,
    tables_read: d.tables_read.slice(0, 5),
    facts_count: d.facts.length,
    inferences_count: d.inferences.length,
    evidence_count: d.evidence.length,
  }));

  const report = {
    at: now,
    project: PROJECT_KEY,
    output: existingPath,
    erzeugte_search_documents: result.documents.length,
    neu_erstellt: result.created,
    aktualisiert: result.updated,
    uebersprungen_unveraendert: result.skipped_unchanged,
    validierungsfehler: result.validation_errors,
    search_text_laenge: stats,
    beispiele: examples,
    geaenderte_dateien: [
      "src/lib/search/searchDocumentSchema.ts",
      "src/lib/search/buildSearchText.ts",
      "src/lib/search/buildSearchDocuments.ts",
      "src/lib/search/indexSearchDocuments.ts",
      "src/lib/search/adapters/codeUnitAnalysis.ts",
      "scripts/index-search-documents.ts",
      "package.json",
      "P01/indexes/classes/search_documents.jsonl",
      "P01/logs/index-search-documents-report.json",
    ],
  };

  writeGeneratedText(
    PROJECT_KEY,
    "logs",
    "index-search-documents-report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  appendLogLine(
    PROJECT_KEY,
    "index-search-documents.log",
    `[${now}] docs=${result.documents.length} created=${result.created} updated=${result.updated} skipped=${result.skipped_unchanged} errors=${result.validation_errors.length}`,
  );

  console.log(`erzeugte SearchDocuments: ${result.documents.length}`);
  console.log(`neu erstellt: ${result.created}`);
  console.log(`aktualisiert: ${result.updated}`);
  console.log(`übersprungen (unverändert): ${result.skipped_unchanged}`);
  console.log(`Validierungsfehler: ${result.validation_errors.length}`);
  console.log(
    `search_text Länge: min=${stats.min} avg=${stats.avg} p50=${stats.p50} p90=${stats.p90} max=${stats.max}`,
  );
  console.log("Beispiele (3):");
  for (const ex of examples) {
    console.log(
      `- ${ex.title} | conf=${ex.confidence} | search_text=${ex.search_text_length} | id=${ex.search_document_id}`,
    );
  }
  console.log("geänderte Dateien:");
  for (const f of report.geaenderte_dateien) console.log(`- ${f}`);
}

main();
