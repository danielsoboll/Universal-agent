/**
 * Programs + Function-Modules: detect → validate → convert (no OpenAI / embeddings / index).
 * Does not touch classes, control-tables, or master-data artifacts.
 *
 * Usage:
 *   npx tsx scripts/run-programs-fm-pipeline.ts [--project P01] [--only programs|function-modules]
 */
import { resolve } from "path";
import { existsSync, statSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import {
  detectProgramsRaw,
  validateProgramsJsonl,
  convertPrograms,
} from "../src/lib/admin/datenbasis/programsPipeline";
import {
  detectFunctionModulesRaw,
  validateFunctionModulesJsonl,
  convertFunctionModules,
} from "../src/lib/admin/datenbasis/functionModulesPipeline";
import { resolveWritablePath } from "../src/lib/localData/paths";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

type Snapshot = { rel: string; mtime: number | null; size: number | null };

function snapshotProtected(projectKey: string): Snapshot[] {
  const rels = [
    "classes/code_units.jsonl",
    "classes/ingest_report.json",
    "classes/relations.jsonl",
    "classes/source_fragments.jsonl",
    "classes/source_objects.jsonl",
    "control-tables/definitions.jsonl",
    "control-tables/contents.jsonl",
    "master-data/materials/ingest_report.json",
    "master-data/customers/ingest_report.json",
    "master-data/vendors/ingest_report.json",
  ];
  return rels.map((rel) => {
    const abs = resolveWritablePath(projectKey, "canonical", rel);
    return {
      rel,
      mtime: existsSync(abs) ? statSync(abs).mtimeMs : null,
      size: existsSync(abs) ? statSync(abs).size : null,
    };
  });
}

function assertUntouched(before: Snapshot[], projectKey: string): string[] {
  const errors: string[] = [];
  for (const b of before) {
    const abs = resolveWritablePath(projectKey, "canonical", b.rel);
    const mtimeAfter = existsSync(abs) ? statSync(abs).mtimeMs : null;
    const sizeAfter = existsSync(abs) ? statSync(abs).size : null;
    if (b.mtime !== mtimeAfter || b.size !== sizeAfter) {
      errors.push(`PROTECTED TOUCHED: canonical/${b.rel}`);
    }
  }
  return errors;
}

async function runDomain(params: {
  projectKey: string;
  label: string;
  detect: typeof detectProgramsRaw;
  validate: typeof validateProgramsJsonl;
  convert: typeof convertPrograms;
}) {
  console.log(JSON.stringify({ step: "detect", domain: params.label }));
  const detect = await params.detect(params.projectKey);
  console.log(
    JSON.stringify(
      {
        step: "detect",
        domain: params.label,
        ok: detect.ok,
        summary: detect.result.summary,
        selected: detect.selected?.fileName,
        counts: detect.result.counts,
        files: detect.files.map((f) => ({
          fileName: f.fileName,
          bytes: f.bytes,
          headerOk: f.headerOk,
          export_type: f.export_type,
          system_id: f.system_id,
        })),
      },
      null,
      2,
    ),
  );
  if (!detect.ok || !detect.selected) {
    return { ok: false as const, domain: params.label };
  }

  const fileName = detect.selected.fileName;
  console.log(
    JSON.stringify({ step: "validate", domain: params.label, fileName }),
  );
  const validate = await params.validate(params.projectKey, fileName);
  console.log(
    JSON.stringify(
      {
        step: "validate",
        domain: params.label,
        ok: validate.ok,
        summary: validate.result.summary,
        counts: validate.result.counts,
        report_path: validate.result.report_path,
        errors: validate.result.errors,
      },
      null,
      2,
    ),
  );
  if (!validate.ok) {
    return { ok: false as const, domain: params.label };
  }

  console.log(
    JSON.stringify({ step: "convert", domain: params.label, fileName }),
  );
  const convert = await params.convert(params.projectKey, fileName);
  console.log(
    JSON.stringify(
      {
        step: "convert",
        domain: params.label,
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
  return {
    ok: convert.ok,
    domain: params.label,
    counts: convert.result.counts,
    report_path: convert.result.report_path,
  };
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const projectKey = (argValue("--project") ?? "P01").trim() || "P01";
  const only = (argValue("--only") ?? "both").trim();

  const before = snapshotProtected(projectKey);
  console.log(
    JSON.stringify({
      step: "start",
      projectKey,
      only,
      protected_snapshot: before.length,
    }),
  );

  const results: Array<{ ok: boolean; domain: string }> = [];

  if (only === "both" || only === "programs") {
    results.push(
      await runDomain({
        projectKey,
        label: "programs",
        detect: detectProgramsRaw,
        validate: validateProgramsJsonl,
        convert: convertPrograms,
      }),
    );
  }

  if (only === "both" || only === "function-modules") {
    results.push(
      await runDomain({
        projectKey,
        label: "function-modules",
        detect: detectFunctionModulesRaw,
        validate: validateFunctionModulesJsonl,
        convert: convertFunctionModules,
      }),
    );
  }

  const touched = assertUntouched(before, projectKey);
  const allOk = results.every((r) => r.ok) && touched.length === 0;
  console.log(
    JSON.stringify(
      {
        step: "done",
        ok: allOk,
        results,
        protected_untouched: touched.length === 0,
        protected_errors: touched,
        notes: [
          "Kein OpenAI",
          "Kein Embedding",
          "Kein Hybrid-Index",
          "RAW unverändert",
        ],
      },
      null,
      2,
    ),
  );
  if (!allOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
