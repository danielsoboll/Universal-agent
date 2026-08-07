/**
 * Build deterministic knowledge graph (no OpenAI / index).
 *
 *   npx tsx scripts/run-knowledge-graph.ts [--project P01] [--overwrite]
 */
import { existsSync, statSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { buildKnowledgeGraph } from "../src/lib/ingest/knowledgeGraphCanonical";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  loadEnvFile();
  const projectKey = argValue("--project") ?? "P01";
  void getLocalDataRoot();
  const overwrite = process.argv.includes("--overwrite");

  const canonicalRoot = resolveWritablePath(projectKey, "canonical");
  if (!existsSync(canonicalRoot) || !statSync(canonicalRoot).isDirectory()) {
    console.error(JSON.stringify({ ok: false, error: "canonical root missing" }));
    process.exit(1);
  }

  console.log(JSON.stringify({ step: "build", projectKey, overwrite }));
  const result = await buildKnowledgeGraph({
    absoluteCanonicalRoot: canonicalRoot,
    overwrite,
  });
  console.log(
    JSON.stringify(
      {
        step: "done",
        ok: result.ok,
        errors: result.errors,
        absoluteDir: result.absoluteDir,
        outputs: result.manifest.outputs,
        stats: {
          nodes_total: result.manifest.stats.nodes_total,
          nodes_by_type: result.manifest.stats.nodes_by_type,
          edges_resolved_unique: result.manifest.stats.edges_resolved_unique,
          edges_dup_merged: result.manifest.stats.edges_dup_merged,
          edges_unresolved_unique:
            result.manifest.stats.edges_unresolved_unique,
          edges_unresolved_dup_merged:
            result.manifest.stats.edges_unresolved_dup_merged,
          name_collisions_not_merged:
            result.manifest.stats.name_collisions_not_merged,
          type_conflicts: result.manifest.stats.type_conflicts,
          sources_read: result.manifest.stats.sources_read,
        },
      },
      null,
      2,
    ),
  );
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
