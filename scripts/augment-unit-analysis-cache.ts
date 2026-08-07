/**
 * Atomic cache-metadata backfill for analyses/classes/unit_analyses.jsonl.
 * Does not re-analyze; does not delete rows.
 *
 *   npx tsx scripts/augment-unit-analysis-cache.ts [--project P01]
 */
import { existsSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { augmentUnitAnalysisCacheMetadata } from "../src/lib/analysis/augmentUnitAnalysisCacheMetadata";
import { appendLogLine } from "../src/lib/localData/fs";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  loadEnvFile();
  const projectKey = argValue("--project") ?? "P01";
  void getLocalDataRoot();

  const abs = resolveWritablePath(
    projectKey,
    "analyses",
    "classes/unit_analyses.jsonl",
  );
  if (!existsSync(abs)) {
    console.error(`Datei fehlt: ${abs}`);
    process.exit(1);
  }

  const stats = await augmentUnitAnalysisCacheMetadata({ absolutePath: abs });
  appendLogLine(
    projectKey,
    "unit-analysis-cache-augment.log",
    `[${new Date().toISOString()}] ${JSON.stringify(stats)}`,
  );
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
