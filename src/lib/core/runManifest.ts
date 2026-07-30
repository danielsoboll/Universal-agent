import { createHash, randomUUID } from "crypto";
import { z } from "zod";

export const PIPELINE_VERSION = "pipeline-cli-v1";

export const runManifestStepSchema = z.object({
  step_id: z.string(),
  status: z.enum(["pending", "running", "skipped", "succeeded", "failed"]),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  npm_script: z.string().nullable().default(null),
  prompt_versions: z.record(z.string(), z.string()).default({}),
  exit_code: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
  notes: z.string().optional(),
  adapter: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  resolved_input_paths: z.array(z.string()).optional(),
  resolved_output_paths: z.array(z.string()).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});

export const runManifestSchema = z.object({
  schema_version: z.literal("1.0"),
  pipeline_version: z.string().default(PIPELINE_VERSION),
  run_id: z.string().min(1),
  customer_id: z.string().min(1),
  system_id: z.string().min(1),
  data_root_project_key: z.string().min(1),
  started_at: z.string(),
  finished_at: z.string().nullable().default(null),
  cli_args: z.array(z.string()).default([]),
  git_commit: z.string().nullable().default(null),
  dry_run: z.boolean().optional(),
  steps: z.array(runManifestStepSchema).default([]),
  /** Content fingerprint of manifest body without finished_at mutations — optional. */
  manifest_hash: z.string().optional(),
});

export type RunManifest = z.infer<typeof runManifestSchema>;
export type RunManifestStep = z.infer<typeof runManifestStepSchema>;

export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}_${randomUUID().slice(0, 8)}`;
}

export function createRunManifest(params: {
  customer_id: string;
  system_id: string;
  data_root_project_key: string;
  cli_args?: string[];
  git_commit?: string | null;
  steps?: RunManifestStep[];
  dry_run?: boolean;
  now?: Date;
}): RunManifest {
  const now = params.now ?? new Date();
  return runManifestSchema.parse({
    schema_version: "1.0",
    pipeline_version: PIPELINE_VERSION,
    run_id: createRunId(now),
    customer_id: params.customer_id,
    system_id: params.system_id,
    data_root_project_key: params.data_root_project_key,
    started_at: now.toISOString(),
    finished_at: null,
    cli_args: params.cli_args ?? [],
    git_commit: params.git_commit ?? null,
    dry_run: params.dry_run ?? false,
    steps: params.steps ?? [],
  });
}

export function hashManifest(manifest: RunManifest): string {
  const { manifest_hash: _h, ...rest } = manifest;
  return createHash("sha256")
    .update(JSON.stringify(rest))
    .digest("hex");
}

export function finalizeManifest(manifest: RunManifest): RunManifest {
  const finished = {
    ...manifest,
    finished_at: new Date().toISOString(),
  };
  return {
    ...finished,
    manifest_hash: hashManifest(finished),
  };
}
