/**
 *   npm run index:sync-master-fields -- --project P01
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { syncMasterFieldsToHybrid } from "../src/lib/search/syncMasterFieldsToHybrid";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const argv = process.argv.slice(2);
  const projectKey = (argValue(argv, "--project") ?? "P01").trim();
  const dryRun = argv.includes("--dry-run");
  const result = await syncMasterFieldsToHybrid({
    projectKey,
    dryRun,
    systemId: "Q01",
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
