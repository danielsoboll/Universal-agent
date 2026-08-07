/**
 * Canonicalize MESSAGE_IDOC_11_RELATIONS → relations.jsonl (+ manifest).
 * Does not touch objects.jsonl / OpenAI / index.
 *
 *   npx tsx scripts/run-message-idoc-11-relations.ts [--project P01]
 */
import { existsSync, statSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { convertMessageIdoc11RelationsPipeline } from "../src/lib/admin/datenbasis/messageIdoc11RelationsPipeline";
import { resolveMessageIdoc11RelationsFile } from "../src/lib/admin/datenbasis/messageIdocConfig/resolveRelations11";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

type Snap = { rel: string; mtime: number | null; size: number | null };

function snapProtected(projectKey: string): Snap[] {
  const rels = [
    "message-idoc-config/objects.jsonl",
    "message-idoc-config/object_ids.jsonl",
    "message-idoc-config/unmapped.jsonl",
    "message-idoc-config/header.json",
    "message-idoc-config/ingest_report.json",
    "classes/relations.jsonl",
    "programs/relations.jsonl",
    "function-modules/relations.jsonl",
    "repository-relations/objects.jsonl",
    "repository-relations/relations.jsonl",
    "repository-relations/unresolved.jsonl",
    "repository-relations/manifest.json",
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

function assertUntouched(before: Snap[], projectKey: string): string[] {
  const errors: string[] = [];
  for (const b of before) {
    const abs = resolveWritablePath(projectKey, "canonical", b.rel);
    const mtime = existsSync(abs) ? statSync(abs).mtimeMs : null;
    const size = existsSync(abs) ? statSync(abs).size : null;
    if (b.mtime !== mtime || b.size !== size) {
      errors.push(`PROTECTED TOUCHED: canonical/${b.rel}`);
    }
  }
  return errors;
}

async function main() {
  loadEnvFile();
  const projectKey = argValue("--project") ?? "P01";
  void getLocalDataRoot();

  const detected = resolveMessageIdoc11RelationsFile(projectKey);
  console.log(
    JSON.stringify({
      step: "detect",
      fileName: detected.fileName,
      bytes: detected.bytes,
      relativePath: `raw/${detected.relativePath}`,
    }),
  );

  const before = snapProtected(projectKey);
  const convert = await convertMessageIdoc11RelationsPipeline(projectKey);
  console.log(
    JSON.stringify(
      {
        step: "convert",
        ok: convert.ok,
        summary: convert.result.summary,
        errors: convert.result.errors,
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
