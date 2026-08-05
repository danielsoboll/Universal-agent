/**
 * Convert MESSAGE_IDOC_CONFIG RAW → Canonical, then optionally sync hybrid index.
 *
 *   npx tsx scripts/run-message-idoc-convert.ts --project P01
 *   npx tsx scripts/run-message-idoc-convert.ts --project P01 --index
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { convertMessageIdocConfig } from "../src/lib/ingest/messageIdocCanonical";
import { syncMessageIdocToHybrid } from "../src/lib/search/syncMessageIdocToHybrid";

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
  const doIndex = argv.includes("--index");

  const converted = await convertMessageIdocConfig(projectKey);
  console.log(JSON.stringify({ convert: converted }, null, 2));

  if (doIndex) {
    const indexed = await syncMessageIdocToHybrid({
      projectKey,
      systemId: "Q01",
      skipChangePointers: true,
    });
    console.log(JSON.stringify({ index: indexed }, null, 2));
    if (!indexed.ok) process.exit(1);
  }
  if (!converted.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
