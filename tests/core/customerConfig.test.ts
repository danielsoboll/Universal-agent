/**
 * Lightweight core tests (no OpenAI, no P01 data).
 *   npx tsx tests/core/customerConfig.test.ts
 */
import assert from "assert";
import path from "path";
import { loadCustomerConfig } from "../../src/lib/core/customerConfig";
import {
  createRunManifest,
  finalizeManifest,
  runManifestSchema,
} from "../../src/lib/core/runManifest";
import { getPipelineStep, listPipelineSteps } from "../../src/lib/core/pipelineRegistry";
import {
  resolvePromptEntry,
  activePromptVersion,
} from "../../src/lib/core/promptRegistry";

const fixtureCustomer = path.resolve(
  process.cwd(),
  "tests/fixtures/customers/demo/customer.json",
);

function testCustomerFixtureLoad() {
  // load via copying semantics: loadCustomerConfig looks in customers/ — so parse file directly
  const { readFileSync } = require("fs") as typeof import("fs");
  const { customerConfigSchema } = require("../../src/lib/core/customerConfig") as typeof import("../../src/lib/core/customerConfig");
  const raw = JSON.parse(readFileSync(fixtureCustomer, "utf8"));
  const parsed = customerConfigSchema.parse(raw);
  assert.equal(parsed.customer_id, "demo");
  assert.equal(parsed.data_root_project_key, "demo");
  assert.ok(parsed.systems.some((s) => s.system_id === "S1"));
  console.log("ok customer fixture schema");
}

function testP01ProfileExists() {
  const cfg = loadCustomerConfig("P01");
  assert.equal(cfg.customer_id, "P01");
  assert.equal(cfg.data_root_project_key, "P01");
  assert.equal(cfg.systems[0]?.system_id, "D01");
  console.log("ok P01 customer profile");
}

function testPromptRegistry() {
  assert.equal(activePromptVersion("unit_analysis"), "unit-analysis-v4");
  const e = resolvePromptEntry("unit_analysis", "unit-analysis-v4");
  assert.equal(e.status, "active");
  console.log("ok prompt registry");
}

function testPipelineRegistry() {
  const steps = listPipelineSteps();
  assert.ok(steps.some((s) => s.id === "canonicalize.control_tables"));
  const analyze = getPipelineStep("analyze.sap_code_units");
  assert.equal(analyze.explicit_only, true);
  assert.equal(analyze.requires_openai, true);
  const reserved = getPipelineStep("analyze.control_tables");
  assert.equal(reserved.status, "reserved");
  console.log("ok pipeline registry");
}

function testManifest() {
  const m = createRunManifest({
    customer_id: "demo",
    system_id: "S1",
    data_root_project_key: "demo",
    cli_args: ["--customer", "demo", "--step", "canonicalize.control_tables"],
  });
  m.steps.push({
    step_id: "canonicalize.control_tables",
    status: "succeeded",
    started_at: m.started_at,
    finished_at: new Date().toISOString(),
    npm_script: "canonicalize:control-tables",
    prompt_versions: {},
    exit_code: 0,
    error: null,
  });
  const final = finalizeManifest(m);
  const parsed = runManifestSchema.parse(final);
  assert.ok(parsed.manifest_hash);
  assert.ok(parsed.finished_at);
  assert.equal(parsed.pipeline_version, "pipeline-cli-v1");
  console.log("ok run manifest");
}

testCustomerFixtureLoad();
testP01ProfileExists();
testPromptRegistry();
testPipelineRegistry();
testManifest();
console.log("all core tests passed");
