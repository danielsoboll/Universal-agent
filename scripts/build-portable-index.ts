/**
 * Build portable local indexes for a customer (P01 first).
 *
 *   npm run index:portable -- --customer P01 --system Q01
 *   npm run index:portable -- --customer P01 --force
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { buildPortableIndex } from "../src/lib/portableIndex/buildPortableIndex";
import {
  loadEnvLocal,
  parseCustomerCliArgs,
  resolveCustomerContext,
} from "../src/lib/search/cliCustomerArgs";

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  loadEnvLocal();
  getLocalDataRoot();

  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const parsed = parseCustomerCliArgs(argv);
  const ctx = resolveCustomerContext({
    customer: parsed.customer,
    system: parsed.system,
  });
  const projectId = ctx.projectKey;
  const systemId = ctx.systemId;

  console.log(
    JSON.stringify(
      {
        action: "build_portable_index",
        projectId,
        systemId,
        force,
        dataRoot: getLocalDataRoot(),
      },
      null,
      2,
    ),
  );

  const result = await buildPortableIndex({
    projectId,
    systemId,
    force,
  });

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        skipped: result.skipped,
        message: result.message,
        duration_ms: result.duration_ms,
        manifest_path: result.manifest_path,
        counts: result.manifest?.counts ?? null,
        paths: result.manifest?.paths ?? null,
      },
      null,
      2,
    ),
  );

  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
