/**
 * Classes pipeline steps B–F (technical) + helpers for A/G manual.
 * RAW is never modified.
 */

import { createHash } from "crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { createInterface } from "readline";
import {
  canonicalizeSapClassExport,
  recordsToJsonl,
} from "@/lib/ingest/sapClassCanonical";
import {
  appendLogLine,
  ensureWritableDir,
  listRawEntries,
  readRawBuffer,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveRawPath, resolveWritablePath } from "@/lib/localData/paths";
import { getExportTypeConfig } from "@/lib/admin/datenbasis/exportTypeConfig";
import type { DatenbasisStepResult } from "@/lib/admin/datenbasis/types";

function nowIso(): string {
  return new Date().toISOString();
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export type DetectedRawFile = {
  relativePath: string;
  fileName: string;
  bytes: number;
  headerOk: boolean;
  headerErrors: string[];
  export_type: string | null;
  system_id: string | null;
  schema_version: string | null;
};

async function readJsonlHeader(
  absolutePath: string,
): Promise<Record<string, unknown> | null> {
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          return obj as Record<string, unknown>;
        }
        return null;
      } catch {
        return null;
      }
    }
  } finally {
    rl.close();
  }
  return null;
}

function validateHeaderAgainstConfig(
  header: Record<string, unknown> | null,
): {
  ok: boolean;
  errors: string[];
  export_type: string | null;
  system_id: string | null;
  schema_version: string | null;
} {
  const cfg = getExportTypeConfig("classes")!;
  const errors: string[] = [];
  if (!header) {
    return {
      ok: false,
      errors: ["Keine gültige Header-Zeile"],
      export_type: null,
      system_id: null,
      schema_version: null,
    };
  }

  const rules = cfg.headerRules ?? {};
  for (const [field, rule] of Object.entries(rules)) {
    const val = header[field];
    const asStr = typeof val === "string" ? val.trim() : "";
    if (rule.required && !asStr) {
      errors.push(`${field} fehlt oder ist leer`);
      continue;
    }
    if (rule.exact != null && asStr !== rule.exact) {
      errors.push(`${field}: erwartet "${rule.exact}", erhalten "${asStr}"`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    export_type:
      typeof header.export_type === "string" ? header.export_type : null,
    system_id: typeof header.system_id === "string" ? header.system_id : null,
    schema_version:
      typeof header.schema_version === "string" ? header.schema_version : null,
  };
}

/** Step B: detect RAW under raw/classes + header validation. */
export async function detectClassesRaw(
  projectKey: string,
  selectedFileName?: string | null,
): Promise<{
  ok: boolean;
  result: DatenbasisStepResult;
  selected: DetectedRawFile | null;
  files: DetectedRawFile[];
}> {
  const cfg = getExportTypeConfig("classes")!;
  const folderParts = cfg.rawFolderParts ?? ["classes"];
  const dirAbs = resolveRawPath(projectKey, ...folderParts);

  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    return {
      ok: false,
      selected: null,
      files: [],
      result: {
        summary: `Ordner fehlt: ${cfg.rawFolder}`,
        ok: false,
        errors: [`${cfg.rawFolder} existiert nicht`],
      },
    };
  }

  let entries: string[];
  try {
    entries = listRawEntries(projectKey, ...folderParts).filter((n) => {
      if (n.startsWith(".") || n === "_quarantine") return false;
      if (!n.toLowerCase().endsWith(".jsonl")) return false;
      // Skip directories (e.g. accidental names); quarantine lives under _quarantine/
      try {
        const abs = resolveRawPath(projectKey, ...folderParts, n);
        return existsSync(abs) && statSync(abs).isFile();
      } catch {
        return false;
      }
    });
  } catch (e) {
    return {
      ok: false,
      selected: null,
      files: [],
      result: {
        summary: "RAW-Ordner nicht lesbar",
        ok: false,
        errors: [e instanceof Error ? e.message : String(e)],
      },
    };
  }

  if (entries.length === 0) {
    return {
      ok: false,
      selected: null,
      files: [],
      result: {
        summary: "Keine .jsonl unter raw/classes",
        ok: false,
        errors: ["Bitte Klassen-Export unter raw/classes ablegen"],
        hint: cfg.observedFilenameExample
          ? `Beobachtetes Beispiel: ${cfg.observedFilenameExample}`
          : undefined,
      },
    };
  }

  const files: DetectedRawFile[] = [];
  for (const fileName of entries) {
    const absolutePath = resolveRawPath(projectKey, ...folderParts, fileName);
    const bytes = statSync(absolutePath).size;
    const header = await readJsonlHeader(absolutePath);
    const hv = validateHeaderAgainstConfig(header);
    files.push({
      relativePath: [...folderParts, fileName].join("/"),
      fileName,
      bytes,
      headerOk: hv.ok,
      headerErrors: hv.errors,
      export_type: hv.export_type,
      system_id: hv.system_id,
      schema_version: hv.schema_version,
    });
  }

  const valid = files.filter((f) => f.headerOk);
  if (valid.length === 0) {
    return {
      ok: false,
      selected: null,
      files,
      result: {
        summary: "Keine Datei mit gültigem Header SAP_CLASSES",
        ok: false,
        errors: files.flatMap((f) =>
          f.headerErrors.map((e) => `${f.fileName}: ${e}`),
        ),
        files: files.map((f) => ({
          relativePath: f.relativePath,
          fileName: f.fileName,
          bytes: f.bytes,
        })),
      },
    };
  }

  let selected: DetectedRawFile | null = null;
  if (selectedFileName) {
    selected =
      valid.find((f) => f.fileName === selectedFileName) ??
      files.find((f) => f.fileName === selectedFileName) ??
      null;
    if (!selected || !selected.headerOk) {
      return {
        ok: false,
        selected: null,
        files,
        result: {
          summary: `Auswahl ungültig: ${selectedFileName}`,
          ok: false,
          errors: ["Gewählte Datei hat keinen gültigen SAP_CLASSES-Header"],
          files: files.map((f) => ({
            relativePath: f.relativePath,
            fileName: f.fileName,
            bytes: f.bytes,
            selected: f.fileName === selectedFileName,
          })),
        },
      };
    }
  } else if (valid.length === 1) {
    selected = valid[0]!;
  } else {
    return {
      ok: false,
      selected: null,
      files,
      result: {
        summary: `${valid.length} gültige Dateien — bitte eine auswählen`,
        ok: false,
        hint: "Mehrere Klassen-Exporte gefunden",
        errors: ["selected_raw_file erforderlich"],
        files: valid.map((f) => ({
          relativePath: f.relativePath,
          fileName: f.fileName,
          bytes: f.bytes,
        })),
        technical: { needs_selection: true, candidates: valid.map((f) => f.fileName) },
      },
    };
  }

  return {
    ok: true,
    selected,
    files,
    result: {
      summary: `RAW erkannt: ${selected.fileName} (export_type=${selected.export_type}, system_id=${selected.system_id})`,
      ok: true,
      files: files.map((f) => ({
        relativePath: f.relativePath,
        fileName: f.fileName,
        bytes: f.bytes,
        selected: f.fileName === selected!.fileName,
      })),
      counts: {
        total: files.length,
        valid_headers: valid.length,
        bytes: selected.bytes,
      },
      technical: {
        export_type: selected.export_type,
        system_id: selected.system_id,
        schema_version: selected.schema_version,
      },
    },
  };
}

/** Step C: streaming JSONL validate. */
export async function validateClassesJsonl(
  projectKey: string,
  fileName: string,
): Promise<{ ok: boolean; result: DatenbasisStepResult }> {
  const folderParts = ["classes"];
  const absolutePath = resolveRawPath(projectKey, ...folderParts, fileName);
  if (!existsSync(absolutePath)) {
    return {
      ok: false,
      result: {
        summary: `Datei fehlt: ${fileName}`,
        ok: false,
        errors: ["RAW-Datei nicht gefunden"],
      },
    };
  }

  const bytes = statSync(absolutePath).size;
  const header = await readJsonlHeader(absolutePath);
  const hv = validateHeaderAgainstConfig(header);
  if (!hv.ok) {
    return {
      ok: false,
      result: {
        summary: "Header-Validierung fehlgeschlagen",
        ok: false,
        errors: hv.errors,
      },
    };
  }

  // Full structural validate via canonicalizer (same rules as convert)
  const buffer = readRawBuffer(projectKey, ...folderParts, fileName);
  const text = buffer.toString("utf8");
  const canonical = canonicalizeSapClassExport({
    text,
    sourceFileName: fileName,
    sourceBytes: bytes,
  });

  const ok =
    canonical.stats.invalid === 0 &&
    canonical.stats.key_collisions === 0 &&
    canonical.headers.length >= 1;

  const id = runId();
  ensureWritableDir(projectKey, "logs", "datenbasis", "classes");
  const reportPath = `datenbasis/classes/validate-${id}.json`;
  const report = {
    ok,
    started_at: nowIso(),
    source: { fileName, bytes },
    header: hv,
    stats: canonical.stats,
    issues: canonical.issues.slice(0, 50),
  };
  writeGeneratedText(
    projectKey,
    "logs",
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );

  return {
    ok,
    result: {
      summary: ok
        ? `Validierung OK: ${canonical.stats.valid} gültige Zeilen, ${canonical.stats.classes} Klassen`
        : `Validierung fehlgeschlagen: ${canonical.stats.invalid} ungültig, ${canonical.stats.key_collisions} Kollisionen`,
      ok,
      report_path: `logs/${reportPath}`,
      counts: {
        lines_total: canonical.stats.lines_total,
        valid: canonical.stats.valid,
        invalid: canonical.stats.invalid,
        classes: canonical.stats.classes,
        methods: canonical.stats.methods,
        fragments: canonical.stats.fragments,
        relations: canonical.stats.relations,
        key_collisions: canonical.stats.key_collisions,
      },
      errors: ok
        ? undefined
        : canonical.issues.slice(0, 10).map((i) => `Z.${i.lineNumber}: ${i.error}`),
      technical: { header: hv },
    },
  };
}

/** Step D: convert to canonical (RAW untouched). */
export function convertClasses(
  projectKey: string,
  fileName: string,
): { ok: boolean; result: DatenbasisStepResult } {
  const folderParts = ["classes"];
  const absolutePath = resolveRawPath(projectKey, ...folderParts, fileName);
  if (!existsSync(absolutePath)) {
    return {
      ok: false,
      result: {
        summary: `Datei fehlt: ${fileName}`,
        ok: false,
        errors: ["RAW-Datei nicht gefunden"],
      },
    };
  }

  const startedAt = nowIso();
  const bytes = statSync(absolutePath).size;
  const buffer = readRawBuffer(projectKey, ...folderParts, fileName);
  const result = canonicalizeSapClassExport({
    text: buffer.toString("utf8"),
    sourceFileName: fileName,
    sourceBytes: bytes,
  });

  ensureWritableDir(projectKey, "canonical", "classes");
  ensureWritableDir(projectKey, "logs", "datenbasis", "classes");

  writeGeneratedText(
    projectKey,
    "canonical",
    "classes/source_objects.jsonl",
    recordsToJsonl(result.sourceObjects),
  );
  writeGeneratedText(
    projectKey,
    "canonical",
    "classes/source_fragments.jsonl",
    recordsToJsonl(result.sourceFragments),
  );
  writeGeneratedText(
    projectKey,
    "canonical",
    "classes/code_units.jsonl",
    recordsToJsonl(result.codeUnits),
  );
  writeGeneratedText(
    projectKey,
    "canonical",
    "classes/relations.jsonl",
    recordsToJsonl(result.relations),
  );

  const ok =
    result.stats.invalid === 0 && result.stats.key_collisions === 0;

  const id = runId();
  const convertReportPath = `datenbasis/classes/convert-${id}.json`;
  const ingestReport = {
    ok,
    started_at: startedAt,
    finished_at: nowIso(),
    project_key: projectKey,
    source: {
      relative: `raw/classes/${fileName}`,
      file_name: fileName,
      bytes,
    },
    outputs: {
      source_objects: "canonical/classes/source_objects.jsonl",
      source_fragments: "canonical/classes/source_fragments.jsonl",
      code_units: "canonical/classes/code_units.jsonl",
      relations: "canonical/classes/relations.jsonl",
      ingest_report: "canonical/classes/ingest_report.json",
    },
    stats: result.stats,
    issues: result.issues,
    notes: ["raw/ unverändert (nur gelesen)", "keine OpenAI-Aufrufe"],
  };

  writeGeneratedText(
    projectKey,
    "canonical",
    "classes/ingest_report.json",
    `${JSON.stringify(ingestReport, null, 2)}\n`,
  );
  writeGeneratedText(
    projectKey,
    "logs",
    convertReportPath,
    `${JSON.stringify(ingestReport, null, 2)}\n`,
  );
  appendLogLine(
    projectKey,
    "datenbasis-classes.log",
    `[${ingestReport.finished_at}] convert classes source=${fileName} ok=${ok} classes=${result.stats.classes}`,
  );

  // Completion check: all artifacts present
  const outputs = [
    "classes/source_objects.jsonl",
    "classes/source_fragments.jsonl",
    "classes/code_units.jsonl",
    "classes/relations.jsonl",
    "classes/ingest_report.json",
  ];
  const missing = outputs.filter(
    (rel) => !existsSync(resolveWritablePath(projectKey, "canonical", rel)),
  );

  const complete = ok && missing.length === 0;

  return {
    ok: complete,
    result: {
      summary: complete
        ? `Konvertierung OK: ${result.stats.classes} Klassen → canonical/classes/`
        : `Konvertierung unvollständig`,
      ok: complete,
      report_path: `logs/${convertReportPath}`,
      counts: { ...result.stats } as unknown as Record<string, number>,
      errors: missing.length
        ? missing.map((m) => `Fehlt: canonical/${m}`)
        : result.issues.slice(0, 5).map((i) => i.error),
      technical: {
        canonical_paths: outputs.map((o) => `canonical/${o}`),
      },
    },
  };
}

/** Step E: 3 data-based test questions from converted canonical. */
export function buildClassesTestQuestions(
  projectKey: string,
): { ok: boolean; result: DatenbasisStepResult } {
  const objectsPath = resolveWritablePath(
    projectKey,
    "canonical",
    "classes/source_objects.jsonl",
  );
  if (!existsSync(objectsPath)) {
    return {
      ok: false,
      result: {
        summary: "Canonical source_objects fehlen — zuerst konvertieren",
        ok: false,
        errors: ["canonical/classes/source_objects.jsonl fehlt"],
      },
    };
  }

  const text = readFileSync(objectsPath, "utf8");
  const objects: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      objects.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }

  const classNames = objects
    .filter(
      (o) =>
        String(o.object_type ?? "")
          .toUpperCase()
          .includes("CLASS") && typeof o.object_name === "string",
    )
    .map((o) => String(o.object_name));

  const primary = classNames[0] ?? null;
  if (!primary) {
    return {
      ok: false,
      result: {
        summary: "Keine Klassen in Canonical gefunden",
        ok: false,
        errors: ["source_objects ohne CLASS"],
      },
    };
  }

  const cases = [
    {
      question: `Was ist die Klasse ${primary}?`,
      ok: true,
      detail: `Objektname aus Canonical: ${primary}`,
    },
    {
      question: `Welche Methoden gehören zu ${primary}?`,
      ok: classNames.length >= 1,
      detail:
        classNames.length >= 1
          ? `${classNames.length} Klassenobjekt(e) in source_objects`
          : "Keine Klassen",
    },
    {
      question: `Wofür wird ${primary} verwendet?`,
      ok: true,
      detail: "Frage aus konvertierten Daten abgeleitet (für RAG-Schritt)",
    },
  ];

  const ok = cases.every((c) => c.ok);
  return {
    ok,
    result: {
      summary: ok
        ? `3 Testfragen aus Canonical (${primary})`
        : "Testfragen unvollständig",
      ok,
      cases,
      technical: { class_names: classNames.slice(0, 10) },
    },
  };
}

/** Step F: Direct RAG smoke using answerQuestion. */
export async function runClassesRagTest(
  projectKey: string,
  questions: string[],
): Promise<{ ok: boolean; result: DatenbasisStepResult }> {
  const samples: Array<{ query: string; ok: boolean; detail: string }> = [];

  try {
    const { answerQuestion } = await import("@/lib/knowledge/answerQuestion");
    const qs =
      questions.length > 0
        ? questions.slice(0, 3)
        : [`Klasse ${projectKey}`];

    for (const q of qs) {
      try {
        const res = await answerQuestion({
          projectId: projectKey,
          question: q,
          searchMode: "direct_rag",
        });
        const hardFail = res.status === "error";
        samples.push({
          query: q,
          ok: !hardFail,
          detail: hardFail
            ? res.direct_answer || "Fehler"
            : `${res.status}; ${res.retrieval_summary || ""}; ${(res.direct_answer || "").slice(0, 120)}`,
        });
      } catch (e) {
        samples.push({
          query: q,
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    return {
      ok: false,
      result: {
        summary: "RAG-Test nicht ausführbar",
        ok: false,
        errors: [e instanceof Error ? e.message : String(e)],
      },
    };
  }

  const pass = samples.filter((s) => s.ok).length;
  const ok = pass === samples.length && samples.length > 0;
  const id = runId();
  const reportPath = `datenbasis/classes/rag-smoke-${id}.json`;
  ensureWritableDir(projectKey, "logs", "datenbasis", "classes");
  writeGeneratedText(
    projectKey,
    "logs",
    reportPath,
    `${JSON.stringify({ ok, samples, at: nowIso() }, null, 2)}\n`,
  );

  return {
    ok,
    result: {
      summary: ok
        ? `RAG-Test OK: ${pass}/${samples.length}`
        : `RAG-Test: ${pass}/${samples.length} bestanden`,
      ok,
      samples,
      report_path: `logs/${reportPath}`,
      counts: { passed: pass, total: samples.length },
    },
  };
}

export function shaShort(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
