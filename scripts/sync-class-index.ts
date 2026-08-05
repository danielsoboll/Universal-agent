/**
 * Incremental sync: complete class unit_analyses → active hybrid search index.
 *
 *   npm run index:sync-classes -- --project P01 --batch-size 250
 *   npm run index:sync-classes -- --project P01 --batch-size 250 --prioritize REBUILD_CVBAP
 *   npm run index:sync-classes -- --project P01 --dry-run
 *
 * Does not stop or modify the running class analysis.
 * Never wipes control tables / other hybrid sources.
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { syncClassAnalysesToHybrid } from "../src/lib/search/syncClassAnalysesToHybrid";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  const argv = process.argv.slice(2);
  const projectKey = (argValue(argv, "--project") ?? "P01").trim();
  const batchSize = Number(argValue(argv, "--batch-size") ?? "250");
  const dryRun = hasFlag(argv, "--dry-run");
  const prioritizeRaw = argValue(argv, "--prioritize");
  const prioritize = prioritizeRaw
    ? prioritizeRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["REBUILD_CVBAP", "ZCL_COPYROUTINE_ZLNP"];

  if (!Number.isFinite(batchSize) || batchSize < 1) {
    console.error("--batch-size muss >= 1 sein");
    process.exit(2);
  }

  console.error(
    `[sync-classes] project=${projectKey} batch=${batchSize} dryRun=${dryRun} prioritize=${prioritize.join(",")}`,
  );

  const result = await syncClassAnalysesToHybrid({
    projectKey,
    batchSize: Math.floor(batchSize),
    dryRun,
    prioritize,
    systemId: "D01",
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
