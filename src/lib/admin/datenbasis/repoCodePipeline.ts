/**
 * Shared Detect → Validate → Convert → Verify for programs / function-modules.
 * RAW never modified. No OpenAI, no embeddings, no hybrid index.
 */

import { createHash } from "crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { createInterface } from "readline";
import {
  closeWriters,
  countJsonlRecords,
  fileBytes,
  openCanonicalWriters,
  patchFileSha256InJsonl,
  repoCodeValidationOk,
  streamCanonicalizeRepoCode,
  verifyEveryUnitHasRawRef,
  type RepoCodeDomain,
} from "@/lib/ingest/sapRepoCodeCanonical";
import {
  appendLogLine,
  ensureWritableDir,
  listRawEntries,
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

export type DetectedRepoRawFile = {
  relativePath: string;
  fileName: string;
  bytes: number;
  headerOk: boolean;
  headerErrors: string[];
  export_type: string | null;
  system_id: string | null;
  schema_version: string | null;
  object_count: number | null;
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

function validateHeader(
  domain: RepoCodeDomain,
  header: Record<string, unknown> | null,
): {
  ok: boolean;
  errors: string[];
  export_type: string | null;
  system_id: string | null;
  schema_version: string | null;
  object_count: number | null;
} {
  const cfg = getExportTypeConfig(domain.id)!;
  const errors: string[] = [];
  if (!header) {
    return {
      ok: false,
      errors: ["Keine gültige Header-Zeile"],
      export_type: null,
      system_id: null,
      schema_version: null,
      object_count: null,
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
  // Filename hint only — never authoritative vs header
  return {
    ok: errors.length === 0,
    errors,
    export_type:
      typeof header.export_type === "string" ? header.export_type : null,
    system_id: typeof header.system_id === "string" ? header.system_id : null,
    schema_version:
      typeof header.schema_version === "string" ? header.schema_version : null,
    object_count:
      typeof header.object_count === "number" ? header.object_count : null,
  };
}

export function createRepoCodePipeline(domain: RepoCodeDomain) {
  const RAW_PARTS = ["programs"] as const;
  const CANON = domain.canonicalDir;
  const LOG_PARTS = ["datenbasis", domain.id] as const;

  async function detectRaw(
    projectKey: string,
    selectedFileName?: string | null,
  ): Promise<{
    ok: boolean;
    result: DatenbasisStepResult;
    selected: DetectedRepoRawFile | null;
    files: DetectedRepoRawFile[];
  }> {
    const cfg = getExportTypeConfig(domain.id)!;
    const dirAbs = resolveRawPath(projectKey, ...RAW_PARTS);
    if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
      return {
        ok: false,
        selected: null,
        files: [],
        result: {
          summary: `Ordner fehlt: raw/programs`,
          ok: false,
          errors: ["raw/programs existiert nicht"],
        },
      };
    }

    let entries: string[];
    try {
      entries = listRawEntries(projectKey, ...RAW_PARTS).filter((n) => {
        if (n.startsWith(".") || n === "_quarantine") return false;
        if (!n.toLowerCase().endsWith(".jsonl")) return false;
        try {
          const abs = resolveRawPath(projectKey, ...RAW_PARTS, n);
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

    const files: DetectedRepoRawFile[] = [];
    for (const fileName of entries) {
      const absolutePath = resolveRawPath(projectKey, ...RAW_PARTS, fileName);
      const bytes = statSync(absolutePath).size;
      const header = await readJsonlHeader(absolutePath);
      const hv = validateHeader(domain, header);
      files.push({
        relativePath: `programs/${fileName}`,
        fileName,
        bytes,
        headerOk: hv.ok,
        headerErrors: hv.errors,
        export_type: hv.export_type,
        system_id: hv.system_id,
        schema_version: hv.schema_version,
        object_count: hv.object_count,
      });
    }

    const valid = files.filter((f) => f.headerOk);
    if (valid.length === 0) {
      return {
        ok: false,
        selected: null,
        files,
        result: {
          summary: `Keine Datei mit Header ${domain.expectedExportType}`,
          ok: false,
          errors: files.flatMap((f) =>
            f.headerErrors.map((e) => `${f.fileName}: ${e}`),
          ),
          files: files.map((f) => ({
            relativePath: f.relativePath,
            fileName: f.fileName,
            bytes: f.bytes,
          })),
          hint: cfg.observedFilenameExample
            ? `Beispiel: ${cfg.observedFilenameExample}`
            : undefined,
        },
      };
    }

    let selected: DetectedRepoRawFile | null = null;
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
            errors: [
              `Gewählte Datei hat keinen gültigen ${domain.expectedExportType}-Header`,
            ],
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
          errors: ["selected_raw_file erforderlich"],
          technical: {
            needs_selection: true,
            candidates: valid.map((f) => f.fileName),
          },
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
          object_count: selected.object_count ?? 0,
        },
        technical: {
          export_type: selected.export_type,
          system_id: selected.system_id,
          schema_version: selected.schema_version,
        },
      },
    };
  }

  async function validateJsonl(
    projectKey: string,
    fileName: string,
  ): Promise<{ ok: boolean; result: DatenbasisStepResult }> {
    const absolutePath = resolveRawPath(projectKey, ...RAW_PARTS, fileName);
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
    const hv = validateHeader(domain, header);
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

    const canonical = await streamCanonicalizeRepoCode({
      domain,
      absolutePath,
      sourceFileName: fileName,
      sourceBytes: bytes,
      writeArtifacts: false,
    });

    const ok = repoCodeValidationOk(canonical);
    const id = runId();
    ensureWritableDir(projectKey, "logs", ...LOG_PARTS);
    const reportPath = `datenbasis/${domain.id}/validate-${id}.json`;
    const report = {
      ok,
      started_at: nowIso(),
      source: { fileName, bytes },
      header: hv,
      stats: canonical.stats,
      header_counts: canonical.headerCounts,
      plausible: canonical.plausible,
      issues: canonical.issues.slice(0, 50),
      notes: [
        "Streaming-Validierung (readline)",
        "Kein OpenAI",
        "RAW unverändert",
      ],
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
          ? `Validierung OK: ${canonical.stats.source_objects} Objekte, ${canonical.stats.raw_code_units} Quellen, ${canonical.stats.relations_raw} Relationen`
          : `Validierung fehlgeschlagen: invalid=${canonical.stats.invalid} collisions=${canonical.stats.key_collisions}`,
        ok,
        report_path: `logs/${reportPath}`,
        counts: {
          lines_total: canonical.stats.lines_total,
          valid: canonical.stats.valid,
          invalid: canonical.stats.invalid,
          source_objects: canonical.stats.source_objects,
          raw_code_units: canonical.stats.raw_code_units,
          relations_raw: canonical.stats.relations_raw,
          derived_code_units: canonical.stats.derived_code_units,
          key_collisions: canonical.stats.key_collisions,
        },
        errors: ok
          ? undefined
          : [
              ...canonical.plausible.notes.filter((n) => !n.includes("stimmen")),
              ...canonical.issues.slice(0, 10).map((i) => `Z.${i.lineNumber}: ${i.error}`),
            ],
        technical: { header: hv, plausible: canonical.plausible },
      },
    };
  }

  async function convert(
    projectKey: string,
    fileName: string,
  ): Promise<{ ok: boolean; result: DatenbasisStepResult }> {
    const absolutePath = resolveRawPath(projectKey, ...RAW_PARTS, fileName);
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
    ensureWritableDir(projectKey, "canonical", CANON);
    ensureWritableDir(projectKey, "logs", ...LOG_PARTS);

    const paths = {
      sourceObjects: resolveWritablePath(
        projectKey,
        "canonical",
        `${CANON}/source_objects.jsonl`,
      ),
      codeUnits: resolveWritablePath(
        projectKey,
        "canonical",
        `${CANON}/code_units.jsonl`,
      ),
      relations: resolveWritablePath(
        projectKey,
        "canonical",
        `${CANON}/relations.jsonl`,
      ),
      extracts: resolveWritablePath(
        projectKey,
        "canonical",
        `${CANON}/extracts.jsonl`,
      ),
    };

    const writers = openCanonicalWriters(paths);
    let canonical;
    try {
      canonical = await streamCanonicalizeRepoCode({
        domain,
        absolutePath,
        sourceFileName: fileName,
        sourceBytes: bytes,
        writers,
        writeArtifacts: true,
      });
    } finally {
      await closeWriters(writers);
    }

    // Patch PENDING sha into written artifacts
    await patchFileSha256InJsonl(paths.sourceObjects, canonical.fileSha256);
    await patchFileSha256InJsonl(paths.codeUnits, canonical.fileSha256);
    await patchFileSha256InJsonl(paths.relations, canonical.fileSha256);
    await patchFileSha256InJsonl(paths.extracts, canonical.fileSha256);

    // Re-read verify
    const reRead = {
      source_objects: await countJsonlRecords(paths.sourceObjects),
      code_units: await countJsonlRecords(paths.codeUnits),
      relations: await countJsonlRecords(paths.relations),
      extracts: await countJsonlRecords(paths.extracts),
    };
    const unitRefCheck = await verifyEveryUnitHasRawRef(paths.codeUnits);

    const outputsRel = [
      `${CANON}/source_objects.jsonl`,
      `${CANON}/code_units.jsonl`,
      `${CANON}/relations.jsonl`,
      `${CANON}/extracts.jsonl`,
      `${CANON}/ingest_report.json`,
      `${CANON}/stats.json`,
    ];
    const missing = outputsRel.filter((rel) => {
      if (rel.endsWith("ingest_report.json") || rel.endsWith("stats.json")) {
        return false; // not written yet
      }
      return !existsSync(resolveWritablePath(projectKey, "canonical", rel));
    });

    const statsConsistent =
      reRead.source_objects === canonical.stats.source_objects &&
      reRead.code_units === canonical.stats.code_units_total &&
      reRead.extracts === canonical.stats.extracts &&
      reRead.relations === canonical.stats.relations_total;

    const structuralOk =
      repoCodeValidationOk(canonical) &&
      missing.length === 0 &&
      unitRefCheck.ok &&
      statsConsistent;

    const id = runId();
    const convertReportPath = `datenbasis/${domain.id}/convert-${id}.json`;
    const ingestReport = {
      ok: structuralOk,
      started_at: startedAt,
      finished_at: nowIso(),
      project_key: projectKey,
      domain: domain.id,
      certainty: "inferred_from_raw" as const,
      source: {
        relative: `raw/programs/${fileName}`,
        file_name: fileName,
        bytes,
        sha256: canonical.fileSha256,
      },
      outputs: {
        source_objects: `canonical/${CANON}/source_objects.jsonl`,
        code_units: `canonical/${CANON}/code_units.jsonl`,
        relations: `canonical/${CANON}/relations.jsonl`,
        extracts: `canonical/${CANON}/extracts.jsonl`,
        ingest_report: `canonical/${CANON}/ingest_report.json`,
        stats: `canonical/${CANON}/stats.json`,
      },
      stats: canonical.stats,
      header: canonical.header,
      header_counts: canonical.headerCounts,
      plausible: canonical.plausible,
      verify: {
        re_read: reRead,
        stats_consistent: statsConsistent,
        every_unit_has_raw_ref: unitRefCheck,
        file_bytes: {
          source_objects: fileBytes(paths.sourceObjects),
          code_units: fileBytes(paths.codeUnits),
          relations: fileBytes(paths.relations),
          extracts: fileBytes(paths.extracts),
        },
      },
      issues: canonical.issues.slice(0, 100),
      notes: [
        "raw/ unverändert (nur gelesen)",
        "keine OpenAI-Aufrufe",
        "kein Embedding / kein Hybrid-Index",
        "Streaming readline",
        `classes/control-tables/master-data unberührt`,
      ],
    };

    writeGeneratedText(
      projectKey,
      "canonical",
      `${CANON}/ingest_report.json`,
      `${JSON.stringify(ingestReport, null, 2)}\n`,
    );
    writeGeneratedText(
      projectKey,
      "canonical",
      `${CANON}/stats.json`,
      `${JSON.stringify(
        {
          ...canonical.stats,
          file_sha256: canonical.fileSha256,
          re_read: reRead,
          converted_at: ingestReport.finished_at,
        },
        null,
        2,
      )}\n`,
    );
    writeGeneratedText(
      projectKey,
      "logs",
      convertReportPath,
      `${JSON.stringify(ingestReport, null, 2)}\n`,
    );
    appendLogLine(
      projectKey,
      `datenbasis-${domain.id}.log`,
      `[${ingestReport.finished_at}] convert ${domain.id} source=${fileName} ok=${structuralOk} objects=${canonical.stats.source_objects} units=${canonical.stats.code_units_total}`,
    );

    const allPresent = outputsRel.every((rel) =>
      existsSync(resolveWritablePath(projectKey, "canonical", rel)),
    );
    const complete = structuralOk && allPresent;

    return {
      ok: complete,
      result: {
        summary: complete
          ? `Konvertierung OK: ${canonical.stats.source_objects} ${domain.titleDe} → canonical/${CANON}/`
          : `Konvertierung unvollständig / Verify fehlgeschlagen`,
        ok: complete,
        report_path: `logs/${convertReportPath}`,
        counts: {
          source_objects: canonical.stats.source_objects,
          raw_code_units: canonical.stats.raw_code_units,
          derived_code_units: canonical.stats.derived_code_units,
          code_units_total: canonical.stats.code_units_total,
          relations_raw: canonical.stats.relations_raw,
          relations_derived: canonical.stats.relations_derived,
          relations_total: canonical.stats.relations_total,
          extracts: canonical.stats.extracts,
          tables_read_refs: canonical.stats.tables_read_refs,
          call_function_refs: canonical.stats.call_function_refs,
        },
        errors: complete
          ? undefined
          : [
              ...(statsConsistent ? [] : ["Stats ≠ Re-Read Counts"]),
              ...(unitRefCheck.ok
                ? []
                : [`${unitRefCheck.missing} Units ohne RAW-Ref`]),
              ...canonical.issues.slice(0, 5).map((i) => i.error),
            ],
        technical: {
          canonical_paths: outputsRel.map((o) => `canonical/${o}`),
          verify: ingestReport.verify,
          no_openai: true,
          no_index: true,
        },
      },
    };
  }

  function buildTestQuestions(projectKey: string): {
    ok: boolean;
    result: DatenbasisStepResult;
  } {
    const objectsPath = resolveWritablePath(
      projectKey,
      "canonical",
      `${CANON}/source_objects.jsonl`,
    );
    if (!existsSync(objectsPath)) {
      return {
        ok: false,
        result: {
          summary: "Canonical source_objects fehlen — zuerst konvertieren",
          ok: false,
          errors: [`canonical/${CANON}/source_objects.jsonl fehlt`],
        },
      };
    }
    const text = readFileSync(objectsPath, "utf8");
    const names: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (typeof o.object_name === "string") names.push(o.object_name);
        if (names.length >= 3) break;
      } catch {
        /* skip */
      }
    }
    const primary = names[0];
    if (!primary) {
      return {
        ok: false,
        result: {
          summary: "Keine Objekte in Canonical",
          ok: false,
          errors: ["source_objects leer"],
        },
      };
    }
    const label =
      domain.id === "programs" ? "Programm" : "Funktionsbaustein";
    const cases = [
      {
        question: `Was macht ${primary}?`,
        ok: true,
        detail: `${label} aus Canonical: ${primary}`,
      },
      {
        question: `Welche Includes gehören zu ${primary}?`,
        ok: true,
        detail: "Relationen INCLUDES / IMPLEMENTED_IN_INCLUDE",
      },
      {
        question: `Welche Tabellen liest ${primary}?`,
        ok: true,
        detail: "Extracts tables_read",
      },
    ];
    return {
      ok: true,
      result: {
        summary: `3 Testfragen aus Canonical (${primary})`,
        ok: true,
        cases,
        technical: { object_names: names },
      },
    };
  }

  function ragTestSkipped(): {
    ok: boolean;
    result: DatenbasisStepResult;
  } {
    return {
      ok: true,
      result: {
        summary:
          "RAG-Test übersprungen (kein Index/Embeddings für diesen Exporttyp)",
        ok: true,
        technical: { skipped: true, no_index: true, no_openai: true },
      },
    };
  }

  return {
    domain,
    detectRaw,
    validateJsonl,
    convert,
    buildTestQuestions,
    ragTestSkipped,
    shaShort(s: string) {
      return createHash("sha256").update(s).digest("hex").slice(0, 12);
    },
  };
}

export type RepoCodePipeline = ReturnType<typeof createRepoCodePipeline>;
