/**
 *   npx tsx tests/localData/resolveDataProjectKey.test.ts
 */
import assert from "assert";
import { resolve } from "path";
import { loadEnvFile } from "../../src/lib/core/loadEnv";
import { BOUND_DATA_PROJECT_KEY } from "../../src/lib/localData/boundProject";
import { getLocalDataRoot } from "../../src/lib/localData/root";
import {
  resolveBoundProjectKey,
  resolveDataProjectKey,
} from "../../src/lib/localData/resolveDataProjectKey";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

assert.strictEqual(BOUND_DATA_PROJECT_KEY, "P01");

const r = resolveDataProjectKey({
  slug: "dgl-z-analyse",
  landscapeLabel: "irgendwas",
  customerId: "uuid-egal",
  hint: "auch-egal",
});

assert.strictEqual(r.projectKey, "P01");
assert.strictEqual(r.source, "bound_universal_agent");
assert.ok(r.projectRoot.endsWith("/P01") || r.projectRoot.endsWith("\\P01"));
assert.ok(r.rejected_slug_path?.includes("dgl-z-analyse"));
assert.strictEqual(resolveBoundProjectKey({ slug: "xyz" }), "P01");

console.log("resolveDataProjectKey.test.ts OK", {
  projectKey: r.projectKey,
  source: r.source,
  bound: BOUND_DATA_PROJECT_KEY,
});
