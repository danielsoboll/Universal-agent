/**
 * Materials-only: detect → validate → convert (no OpenAI / embeddings / index).
 * Does not touch classes canonical or indexes.
 *
 * Usage: npx tsx scripts/run-materials-pipeline.ts [--project P01]
 */
import { resolve } from "path";
import { existsSync, statSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import {
  detectMaterialsRaw,
  validateMaterialsJsonl,
  convertMaterials,
  MATERIALS_SET_TOKEN,
} from "../src/lib/admin/datenbasis/materialsPipeline";
import { resolveWritablePath } from "../src/lib/localData/paths";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const projectKey = (argValue("--project") ?? "P01").trim() || "P01";

  const classesBefore = [
    "classes/code_units.jsonl",
    "classes/ingest_report.json",
    "classes/relations.jsonl",
    "classes/source_fragments.jsonl",
    "classes/source_objects.jsonl",
  ].map((rel) => {
    const abs = resolveWritablePath(projectKey, "canonical", rel);
    return {
      rel,
      mtime: existsSync(abs) ? statSync(abs).mtimeMs : null,
      size: existsSync(abs) ? statSync(abs).size : null,
    };
  });

  console.log(JSON.stringify({ step: "detect", projectKey }));
  const detect = await detectMaterialsRaw(projectKey);
  console.log(
    JSON.stringify(
      {
        step: "detect",
        ok: detect.ok,
        summary: detect.result.summary,
        selected: detect.selected?.fileName,
        completeness: detect.completeness,
        mapping: detect.mapped.map((f) => ({
          fileName: f.fileName,
          bytes: f.bytes,
          table_name: f.table_name,
          kind: f.kind,
          export_type: f.export_type,
          system_id: f.system_id,
          schema_version: f.schema_version,
          profile: f.profile,
          headerOk: f.headerOk,
          headerErrors: f.headerErrors,
        })),
      },
      null,
      2,
    ),
  );
  if (!detect.ok || !detect.selected) {
    process.exitCode = 1;
    return;
  }

  const token = detect.selected.fileName;
  console.log(JSON.stringify({ step: "validate", token }));
  const validate = await validateMaterialsJsonl(projectKey, token);
  console.log(
    JSON.stringify(
      {
        step: "validate",
        ok: validate.ok,
        summary: validate.result.summary,
        counts: validate.result.counts,
        report_path: validate.result.report_path,
        errors: validate.result.errors,
        technical: validate.result.technical,
      },
      null,
      2,
    ),
  );
  if (!validate.ok) {
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ step: "convert", token }));
  const convert = await convertMaterials(projectKey, token);
  console.log(
    JSON.stringify(
      {
        step: "convert",
        ok: convert.ok,
        summary: convert.result.summary,
        counts: convert.result.counts,
        report_path: convert.result.report_path,
        errors: convert.result.errors,
        technical: convert.result.technical,
      },
      null,
      2,
    ),
  );

  const classesAfter = classesBefore.map((c) => {
    const abs = resolveWritablePath(projectKey, "canonical", c.rel);
    const mtimeAfter = existsSync(abs) ? statSync(abs).mtimeMs : null;
    const sizeAfter = existsSync(abs) ? statSync(abs).size : null;
    return {
      rel: c.rel,
      mtimeBefore: c.mtime,
      sizeBefore: c.size,
      mtimeAfter,
      sizeAfter,
      unchanged: c.mtime === mtimeAfter && c.size === sizeAfter,
    };
  });

  console.log(
    JSON.stringify(
      {
        step: "classes_undisturbed_check",
        set_token: MATERIALS_SET_TOKEN,
        all_unchanged: classesAfter.every((c) => c.unchanged),
        files: classesAfter,
      },
      null,
      2,
    ),
  );

  if (!convert.ok || !classesAfter.every((c) => c.unchanged)) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
