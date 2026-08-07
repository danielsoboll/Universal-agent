/**
 * Repository-Relations Pass 1: detect → validate → convert.
 * No OpenAI / embeddings / index. Does not touch other canonical domains.
 *
 * Usage:
 *   npx tsx scripts/run-repository-relations-pipeline.ts [--project P01]
 */
import { existsSync, statSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveWritablePath } from "../src/lib/localData/paths";
import {
  convertRepositoryRelations,
  detectRepositoryRelationsRaw,
  validateRepositoryRelationsJsonl,
} from "../src/lib/admin/datenbasis/repositoryRelationsPipeline";

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
    "classes/source_objects.jsonl",
    "programs/relations.jsonl",
    "programs/ingest_report.json",
    "function-modules/relations.jsonl",
    "function-modules/ingest_report.json",
    "message-idoc-config/objects.jsonl",
    "message-idoc-config/relations.jsonl",
    "message-idoc-config/ingest_report.json",
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

async function main() {
  loadEnvFile();
  const projectKey = argValue("--project") ?? "P01";
  void getLocalDataRoot();

  const before = snapshotProtected(projectKey);

  console.log(JSON.stringify({ step: "detect", projectKey }));
  const detect = await detectRepositoryRelationsRaw(projectKey);
  console.log(JSON.stringify({ step: "detect", ...detect.result, selected: detect.selected }, null, 2));
  if (!detect.ok) process.exit(1);

  console.log(JSON.stringify({ step: "validate" }));
  const validate = await validateRepositoryRelationsJsonl(projectKey);
  console.log(JSON.stringify({ step: "validate", ...validate.result }, null, 2));
  if (!validate.ok) process.exit(1);

  console.log(JSON.stringify({ step: "convert_pass1" }));
  const convert = await convertRepositoryRelations(projectKey);
  console.log(
    JSON.stringify(
      {
        step: "convert_pass1",
        ...convert.result,
        stats: convert.manifest?.stats,
        outputs: convert.manifest?.outputs,
      },
      null,
      2,
    ),
  );

  const touched = assertUntouched(before, projectKey);
  if (touched.length) {
    console.error(JSON.stringify({ step: "protection", errors: touched }));
    process.exit(1);
  }

  if (!convert.ok) process.exit(1);
  console.log(JSON.stringify({ step: "done", ok: true }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
