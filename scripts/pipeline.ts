/**
 * Generic pipeline CLI — customer_id + system_id, step registry, run manifest.
 * Does not change business logic; delegates to existing npm scripts.
 *
 *   npm run pipeline -- --customer P01 --list-steps
 *   npm run pipeline -- --customer P01 --system D01 --step canonicalize.control_tables
 *   npm run pipeline -- --customer P01 --init-layout
 *
 * OpenAI / reserved steps require explicit --step and are never auto-chained.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import {
  loadCustomerConfig,
  resolveSystemId,
  type CustomerConfig,
} from "../src/lib/core/customerConfig";
import { loadEnvFile, tryReadGitHead } from "../src/lib/core/loadEnv";
import {
  getPipelineStep,
  listPipelineSteps,
  type PipelineStepDefinition,
} from "../src/lib/core/pipelineRegistry";
import { activePromptVersion } from "../src/lib/core/promptRegistry";
import {
  createRunManifest,
  finalizeManifest,
  type RunManifest,
  type RunManifestStep,
} from "../src/lib/core/runManifest";
import { LocalDataError } from "../src/lib/localData/errors";
import { ensureWritableDir, writeGeneratedText } from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const out: {
    customer?: string;
    system?: string;
    step?: string;
    listSteps: boolean;
    initLayout: boolean;
    includeReserved: boolean;
    dryRun: boolean;
  } = {
    listSteps: false,
    initLayout: false,
    includeReserved: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--customer" || a === "-c") out.customer = argv[++i];
    else if (a.startsWith("--customer=")) out.customer = a.slice("--customer=".length);
    else if (a === "--system" || a === "-s") out.system = argv[++i];
    else if (a.startsWith("--system=")) out.system = a.slice("--system=".length);
    else if (a === "--step") out.step = argv[++i];
    else if (a.startsWith("--step=")) out.step = a.slice("--step=".length);
    else if (a === "--list-steps") out.listSteps = true;
    else if (a === "--init-layout") out.initLayout = true;
    else if (a === "--include-reserved") out.includeReserved = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else fail(`Unbekanntes Argument: ${a}`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  npm run pipeline -- --customer <id> --list-steps
  npm run pipeline -- --customer <id> --system <sys> --step <step_id>
  npm run pipeline -- --customer <id> --init-layout

Flags:
  --dry-run            Manifest schreiben, Script nicht ausführen
  --include-reserved   Reserved Steps in --list-steps zeigen
`);
}

function initCustomerLayout(config: CustomerConfig) {
  const project = config.data_root_project_key;
  const dirs = [
    ["raw", "classes"],
    ["raw", "control-tables", "definitions"],
    ["raw", "control-tables", "contents"],
    ["canonical", "classes"],
    ["canonical", "control-tables"],
    ["canonical", "relations"],
    ["analyses", "classes"],
    ["analyses", "control-tables"],
    ["analyses", "relations"],
    ["indexes", "classes"],
    ["embeddings"],
    ["logs", "runs"],
  ] as const;

  // raw is read-only via helpers — create via LOCAL_DATA_ROOT directly is not allowed
  // through write helpers. Use ensure only for writable zones; raw mkdir via root path check.
  const root = getLocalDataRoot();
  for (const parts of dirs) {
    const absolute = path.join(root, project, ...parts);
    if (!existsSync(absolute)) {
      mkdirSync(absolute, { recursive: true });
    }
  }
  console.log(`Layout bereit unter LOCAL_DATA_ROOT/${project}/`);
}

function writeManifest(
  config: CustomerConfig,
  manifest: RunManifest,
): string {
  const project = config.data_root_project_key;
  ensureWritableDir(project, "logs", "runs", manifest.run_id);
  const relative = `runs/${manifest.run_id}/manifest.json`;
  writeGeneratedText(
    project,
    "logs",
    relative,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return resolveWritablePath(project, "logs", relative);
}

function promptPinsForStep(
  step: PipelineStepDefinition,
  config: CustomerConfig,
): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const promptId of step.prompt_ids) {
    pins[promptId] =
      config.pipeline_defaults.prompt_versions[promptId] ??
      activePromptVersion(promptId);
  }
  return pins;
}

function runNpmScript(script: string, dryRun: boolean): number {
  if (dryRun) {
    console.log(`[dry-run] npm run ${script}`);
    return 0;
  }
  const result = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  return result.status ?? 1;
}

function normalizeStepId(raw: string): string {
  // Allow accidental hyphens: canonicalize.control-tables → canonicalize.control_tables
  return raw.trim().replace(/-/g, "_");
}

function resolveUnderProject(
  projectKey: string,
  relativeParts: string[],
): string {
  return path.join(getLocalDataRoot(), projectKey, ...relativeParts);
}

function printExecutionPlan(params: {
  config: CustomerConfig;
  systemId: string;
  step: PipelineStepDefinition;
  promptVersions: Record<string, string>;
  dryRun: boolean;
}) {
  const project = params.config.data_root_project_key;
  const inputs = params.step.inputs.map((rel) =>
    resolveUnderProject(project, rel.split("/")),
  );
  const outputs = params.step.outputs.map((rel) =>
    resolveUnderProject(project, rel.split("/")),
  );
  console.log(params.dryRun ? "=== DRY RUN (keine Dateiänderung, kein npm) ===" : "=== Pipeline-Plan ===");
  console.log(`customer_id: ${params.config.customer_id} (nur Konfiguration)`);
  console.log(`system_id: ${params.systemId}`);
  console.log(`data_root_project_key: ${project}`);
  console.log(`LOCAL_DATA_ROOT: ${getLocalDataRoot()}`);
  console.log(`step: ${params.step.id}`);
  console.log(`adapter: ${params.step.adapter}`);
  console.log(`requires_openai: ${params.step.requires_openai}`);
  console.log(`npm_script: ${params.step.npm_script ?? "-"}`);
  console.log(`prompt_versions: ${JSON.stringify(params.promptVersions)}`);
  console.log("inputs:");
  for (const p of inputs) console.log(`  - ${p}`);
  console.log("outputs:");
  for (const p of outputs) console.log(`  - ${p}`);
}

function main() {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));

  if (!args.customer) {
    fail("--customer <id> ist erforderlich. Siehe --help.");
  }

  let config: CustomerConfig;
  try {
    config = loadCustomerConfig(args.customer);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  if (args.listSteps) {
    console.log(`Kunde: ${config.customer_id} (${config.display_name})`);
    console.log(`Datenordner: LOCAL_DATA_ROOT/${config.data_root_project_key}`);
    console.log(`customer_id ist Konfiguration (Datei customers/${config.customer_id}.json)`);
    for (const step of listPipelineSteps({
      includeReserved: args.includeReserved,
    })) {
      console.log(
        `- ${step.id} [adapter=${step.adapter}] [${step.status}] openai=${step.requires_openai} script=${step.npm_script ?? "-"}`,
      );
    }
    return;
  }

  if (args.initLayout) {
    initCustomerLayout(config);
    return;
  }

  if (!args.step) {
    fail(
      "Kein --step angegeben. Nutze --list-steps oder --init-layout. (Kein automatischer Full-Run — schützt OpenAI-Piloten.)",
    );
  }

  let step: PipelineStepDefinition;
  try {
    step = getPipelineStep(normalizeStepId(args.step));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (step.status === "reserved") {
    fail(
      `Step ${step.id} ist reserved und wird von dieser CLI nicht gestartet (Pilot separat).`,
    );
  }

  if (
    step.explicit_only &&
    config.pipeline_defaults.require_explicit_step.includes(step.id)
  ) {
    console.log(
      `Hinweis: ${step.id} ist explicit_only (OpenAI/Analyse) — nur bewusst gestartet.`,
    );
  }

  let systemId: string;
  try {
    systemId = resolveSystemId(config, args.system);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  process.env.PIPELINE_CUSTOMER_ID = config.customer_id;
  process.env.PIPELINE_SYSTEM_ID = systemId;
  process.env.PIPELINE_PROJECT_KEY = config.data_root_project_key;

  const promptVersions = promptPinsForStep(step, config);
  const project = config.data_root_project_key;
  const resolvedInputs = step.inputs.map((rel) =>
    resolveUnderProject(project, rel.split("/")),
  );
  const resolvedOutputs = step.outputs.map((rel) =>
    resolveUnderProject(project, rel.split("/")),
  );

  printExecutionPlan({
    config,
    systemId,
    step,
    promptVersions,
    dryRun: args.dryRun,
  });

  if (args.dryRun) {
    console.log("Dry-Run beendet: kein Manifest geschrieben, kein OpenAI, keine Datenänderung.");
    return;
  }

  const startedMs = Date.now();
  const manifest = createRunManifest({
    customer_id: config.customer_id,
    system_id: systemId,
    data_root_project_key: config.data_root_project_key,
    cli_args: process.argv.slice(2),
    git_commit: tryReadGitHead(),
    dry_run: false,
  });

  const stepRecord: RunManifestStep = {
    step_id: step.id,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    npm_script: step.npm_script,
    prompt_versions: promptVersions,
    exit_code: null,
    error: null,
    adapter: step.adapter,
    inputs: [...step.inputs],
    outputs: [...step.outputs],
    resolved_input_paths: resolvedInputs,
    resolved_output_paths: resolvedOutputs,
  };
  manifest.steps.push(stepRecord);
  writeManifest(config, manifest);

  if (!step.npm_script) {
    stepRecord.status = "failed";
    stepRecord.error = "Kein npm_script hinterlegt";
    stepRecord.finished_at = new Date().toISOString();
    stepRecord.duration_ms = Date.now() - startedMs;
    const failed = finalizeManifest(manifest);
    const p = writeManifest(config, failed);
    fail(`Step ohne Script: ${step.id}. Manifest: ${p}`);
  }

  console.log(
    `Run ${manifest.run_id}: customer=${config.customer_id} system=${systemId} step=${step.id}`,
  );
  const code = runNpmScript(step.npm_script, false);
  stepRecord.finished_at = new Date().toISOString();
  stepRecord.duration_ms = Date.now() - startedMs;
  stepRecord.exit_code = code;
  stepRecord.status = code === 0 ? "succeeded" : "failed";
  if (code !== 0) stepRecord.error = `npm run ${step.npm_script} exit ${code}`;

  const finalManifest = finalizeManifest(manifest);
  const manifestPath = writeManifest(config, finalManifest);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`duration_ms: ${stepRecord.duration_ms}`);
  if (code !== 0) process.exit(code);
}

main();
