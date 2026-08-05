/**
 * Customers + vendors: detect → validate → convert (no OpenAI / embeddings / index).
 * Does not touch classes, materials, or control-tables artifacts.
 *
 * Usage: npx tsx scripts/run-customers-vendors-pipeline.ts [--project P01] [--only customers|vendors]
 */
import { resolve } from "path";
import { existsSync, statSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import {
  detectCustomersRaw,
  validateCustomersJsonl,
  convertCustomers,
  CUSTOMERS_SET_TOKEN,
} from "../src/lib/admin/datenbasis/customersPipeline";
import {
  detectVendorsRaw,
  validateVendorsJsonl,
  convertVendors,
  VENDORS_SET_TOKEN,
} from "../src/lib/admin/datenbasis/vendorsPipeline";
import { resolveWritablePath } from "../src/lib/localData/paths";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

type Snapshot = {
  rel: string;
  mtime: number | null;
  size: number | null;
};

function snapshotArtifacts(projectKey: string): Snapshot[] {
  const rels = [
    "classes/code_units.jsonl",
    "classes/ingest_report.json",
    "classes/relations.jsonl",
    "classes/source_fragments.jsonl",
    "classes/source_objects.jsonl",
    "master-data/materials/header.json",
    "master-data/materials/ingest_report.json",
    "master-data/materials/records.jsonl",
    "control-tables/ingest_report.json",
    "control-tables/table_relations.jsonl",
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

function checkUndisturbed(
  projectKey: string,
  before: Snapshot[],
): { all_unchanged: boolean; files: Array<Record<string, unknown>> } {
  const files = before.map((c) => {
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
  return {
    all_unchanged: files.every((f) => f.unchanged),
    files,
  };
}

async function runDomain(
  label: "customers" | "vendors",
  projectKey: string,
): Promise<boolean> {
  const detect =
    label === "customers" ? detectCustomersRaw : detectVendorsRaw;
  const validate =
    label === "customers" ? validateCustomersJsonl : validateVendorsJsonl;
  const convert =
    label === "customers" ? convertCustomers : convertVendors;
  const setToken =
    label === "customers" ? CUSTOMERS_SET_TOKEN : VENDORS_SET_TOKEN;

  console.log(JSON.stringify({ step: "detect", domain: label, projectKey }));
  const d = await detect(projectKey);
  console.log(
    JSON.stringify(
      {
        step: "detect",
        domain: label,
        ok: d.ok,
        summary: d.result.summary,
        selected: d.selected?.fileName,
        completeness: d.completeness,
        mapping: d.mapped.map((f) => ({
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
  if (!d.ok || !d.selected) return false;

  const token = d.selected.fileName || setToken;
  console.log(JSON.stringify({ step: "validate", domain: label, token }));
  const v = await validate(projectKey, token);
  console.log(
    JSON.stringify(
      {
        step: "validate",
        domain: label,
        ok: v.ok,
        summary: v.result.summary,
        counts: v.result.counts,
        report_path: v.result.report_path,
        errors: v.result.errors,
        technical: v.result.technical,
      },
      null,
      2,
    ),
  );
  if (!v.ok) return false;

  console.log(JSON.stringify({ step: "convert", domain: label, token }));
  const c = await convert(projectKey, token);
  console.log(
    JSON.stringify(
      {
        step: "convert",
        domain: label,
        ok: c.ok,
        summary: c.result.summary,
        counts: c.result.counts,
        report_path: c.result.report_path,
        errors: c.result.errors,
        technical: c.result.technical,
      },
      null,
      2,
    ),
  );
  return c.ok;
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const projectKey = (argValue("--project") ?? "P01").trim() || "P01";
  const only = (argValue("--only") ?? "both").trim().toLowerCase();

  const before = snapshotArtifacts(projectKey);
  let ok = true;

  if (only === "both" || only === "customers") {
    if (!(await runDomain("customers", projectKey))) ok = false;
  }
  if (only === "both" || only === "vendors") {
    if (!(await runDomain("vendors", projectKey))) ok = false;
  }

  const undisturbed = checkUndisturbed(projectKey, before);
  console.log(
    JSON.stringify(
      {
        step: "artifacts_undisturbed_check",
        all_unchanged: undisturbed.all_unchanged,
        files: undisturbed.files,
        guarantees: {
          no_openai: true,
          no_index_rebuild: true,
          raw_immutable: true,
        },
      },
      null,
      2,
    ),
  );

  if (!ok || !undisturbed.all_unchanged) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
