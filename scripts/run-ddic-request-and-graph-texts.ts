/**
 * Build DDIC_REQUEST.jsonl + rebuild knowledge graph with message-idoc objects/texts.
 * No OpenAI / index / class analysis.
 *
 *   npx tsx scripts/run-ddic-request-and-graph-texts.ts [--project P01]
 */
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { ensureWritableDir } from "../src/lib/localData/fs";
import { resolveWritablePath } from "../src/lib/localData/paths";
import { buildDdicRequest } from "../src/lib/ingest/ddicRequestCanonical";
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

  const canonicalRoot = resolveWritablePath(projectKey, "canonical");
  const requestsDir = ensureWritableDir(projectKey, "requests");

  console.log(JSON.stringify({ step: "ddic_request", projectKey }));
  const ddic = await buildDdicRequest({
    absoluteCanonicalRoot: canonicalRoot,
    absoluteRequestsDir: requestsDir,
    systemId: "Q01",
  });
  console.log(
    JSON.stringify(
      {
        step: "ddic_request",
        ok: ddic.ok,
        path: ddic.absolutePath,
        errors: ddic.errors,
        stats: ddic.stats,
      },
      null,
      2,
    ),
  );
  if (!ddic.ok) process.exit(1);

  console.log(JSON.stringify({ step: "knowledge_graph_rebuild_with_texts" }));
  const kg = await buildKnowledgeGraph({
    absoluteCanonicalRoot: canonicalRoot,
    overwrite: true,
  });
  console.log(
    JSON.stringify(
      {
        step: "knowledge_graph",
        ok: kg.ok,
        errors: kg.errors,
        nodes: kg.manifest.stats.nodes_total,
        edges: kg.manifest.stats.edges_resolved_unique,
        unresolved: kg.manifest.stats.edges_unresolved_unique,
        sources_read: kg.manifest.stats.sources_read,
        nodes_by_type_focus: {
          OUTPUT_TYPE: kg.manifest.stats.nodes_by_type.OUTPUT_TYPE,
          OUTPUT_TYPE_TEXT: kg.manifest.stats.nodes_by_type.OUTPUT_TYPE_TEXT,
          MESSAGE_TYPE: kg.manifest.stats.nodes_by_type.MESSAGE_TYPE,
          IDOC_TYPE: kg.manifest.stats.nodes_by_type.IDOC_TYPE,
        },
      },
      null,
      2,
    ),
  );
  if (!kg.ok) process.exit(1);
  console.log(JSON.stringify({ step: "done", ok: true }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
