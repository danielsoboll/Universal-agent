/**
 * Sync Control-Tables Fahrplan with already-active Q01 knowledge (verify-only).
 * Does NOT reconvert RAW, wipe, or rebuild.
 *
 *   npx tsx scripts/sync-control-tables-fahrplan.ts --project P01
 *   npx tsx scripts/sync-control-tables-fahrplan.ts --project P01 --steps 5,6
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import {
  loadControlTablesFahrplanState,
  runControlTablesFahrplanStep,
  syncControlTablesFahrplanFromActiveEvidence,
  verifyExistingKnowledge,
} from "../src/lib/rebuild/controlTablesFahrplan";
import type { FahrplanStepId } from "../src/lib/rebuild/controlTablesFahrplanTypes";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  const argv = process.argv.slice(2);
  const projectKey = (argValue(argv, "--project") ?? "P01").trim() || "P01";
  const stepsArg = argValue(argv, "--steps") ?? "5,6";
  const stepIds = stepsArg
    .split(",")
    .map((s) => Number(s.trim()) as FahrplanStepId)
    .filter((n) => n === 5 || n === 6);

  console.log(JSON.stringify({ phase: "verify", projectKey }, null, 2));
  const evidence = verifyExistingKnowledge(projectKey);
  console.log(
    JSON.stringify(
      {
        phase: "evidence",
        ok: evidence.ok,
        missing: evidence.missing,
        search_documents: evidence.search_documents_count,
        embeddings: evidence.embeddings_count,
        index_entries: evidence.index_entries,
        activated_at: evidence.activated_at,
        raw_sources: evidence.raw_sources,
      },
      null,
      2,
    ),
  );

  if (!evidence.ok) {
    console.error("VERIFY_FAILED");
    process.exit(1);
  }

  const synced = syncControlTablesFahrplanFromActiveEvidence(projectKey);
  console.log(
    JSON.stringify(
      {
        phase: "sync_1_4",
        ok: synced.ok,
        message: synced.message,
        steps: Object.fromEntries(
          ([1, 2, 3, 4, 5, 6] as const).map((id) => [
            id,
            synced.state.steps[id].status,
          ]),
        ),
      },
      null,
      2,
    ),
  );
  if (!synced.ok) {
    process.exit(1);
  }

  for (const stepId of stepIds) {
    const result = await runControlTablesFahrplanStep({
      projectKey,
      stepId,
      customerId: projectKey,
      systemId: "Q01",
    });
    console.log(
      JSON.stringify(
        {
          phase: `step_${stepId}`,
          ok: result.ok,
          message: result.message,
          status: result.state.steps[stepId].status,
          knowledge_activated_at: result.state.knowledge_activated_at,
          overall: result.state.overall,
          result: result.state.steps[stepId].result,
        },
        null,
        2,
      ),
    );
    if (!result.ok) {
      process.exit(1);
    }
  }

  const final = loadControlTablesFahrplanState(projectKey);
  console.log(
    JSON.stringify(
      {
        phase: "final",
        overall: final.overall,
        knowledge_activated_at: final.knowledge_activated_at,
        steps: Object.fromEntries(
          ([1, 2, 3, 4, 5, 6] as const).map((id) => [
            id,
            {
              status: final.steps[id].status,
              summary: final.steps[id].result?.summary ?? null,
            },
          ]),
        ),
        evidence: {
          search_documents: evidence.search_documents_count,
          embeddings: evidence.embeddings_count,
          index_entries: evidence.index_entries,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
