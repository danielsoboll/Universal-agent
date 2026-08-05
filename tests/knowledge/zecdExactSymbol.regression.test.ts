/**
 * Hard regression: „Was wissen wir über die Nachricht ZECD?“
 *
 *   npx tsx tests/knowledge/zecdExactSymbol.regression.test.ts
 */
import assert from "assert";
import { resolve } from "path";
import { loadEnvFile } from "../../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../../src/lib/localData/root";
import { fileProjectRepository } from "../../src/lib/localAuth/projectRepository";
import { runMultiSourceSearch } from "../../src/lib/knowledge/multiSourceSearch";
import { extractTechnicalSymbols } from "../../src/lib/search/technicalSymbols";
import { detectTechnicalSymbolPrimary } from "../../src/lib/knowledge/multiSourceSearch/primaryAnchor";
import { isGenericMessageNoise } from "../../src/lib/knowledge/multiSourceSearch/primaryAnchor";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

const QUESTION = "Was wissen wir über die Nachricht ZECD?";

async function main() {
  const symbols = extractTechnicalSymbols(QUESTION);
  assert.ok(
    symbols.some((s) => s.norm === "ZECD"),
    "ZECD must be extracted as exact_symbol token",
  );

  const projects = await fileProjectRepository.list();
  const project =
    projects.find((p) => p.customer_id === "P01") ?? projects[0];
  assert.ok(project, "P01 project required");

  const run = await runMultiSourceSearch({
    projectId: project!.id,
    question: QUESTION,
    maxRounds: 2,
    synthesize: false,
  });

  const exactStage = run.stages.find((s) => s.stage === "exact_symbol");
  assert.ok(exactStage, "exact_symbol stage must run");
  assert.ok(
    (exactStage!.hits.length ?? 0) >= 1,
    "at least one exact symbol hit",
  );

  const techPrimary = detectTechnicalSymbolPrimary(exactStage!.hits, run.plan);
  assert.ok(techPrimary, "technical symbol primary from exact hits");
  assert.strictEqual(techPrimary!.symbol, "ZECD");
  assert.ok(
    (techPrimary!.objects ?? []).some((o) => /ZECD/i.test(o)),
    "primary objects must contain ZECD in name",
  );

  assert.strictEqual(
    run.specialized_plan.plan_type,
    "TECHNICAL_SYMBOL_TO_PROCESS",
    `plan_type=${run.specialized_plan.plan_type}`,
  );
  assert.strictEqual(
    run.specialized_plan.primary_anchor?.anchor_type,
    "TECHNICAL_SYMBOL",
  );

  const zecdObjects = (run.specialized_plan.primary_anchor?.objects ?? []).filter(
    (o) => /ZECD/i.test(o),
  );
  assert.ok(zecdObjects.length >= 1, "at least one real ZECD object named");

  // Evidence must include exact_symbol hits
  const exactEvidence = run.evidence.items.filter(
    (i) => i.source === "exact_symbol",
  );
  assert.ok(exactEvidence.length >= 1, "exact_symbol evidence in final bundle");

  // No generic MESSAGE tables as main evidence without relation
  for (const item of run.evidence.items.slice(0, 8)) {
    const noisy = isGenericMessageNoise(
      item,
      zecdObjects,
      ["ZECD"],
    );
    assert.ok(
      !noisy,
      `top evidence must not be generic MESSAGE noise: ${item.title}`,
    );
    if (/ZTMO_MESSAGES|ZPO_BA00/i.test(item.title)) {
      assert.ok(
        item.related_to_symbol ||
          /ZECD/i.test(`${item.title} ${item.summary}`),
        `ZTMO_MESSAGES/ZPO_BA00 only with ZECD relation: ${item.title}`,
      );
    }
  }

  // Misclassification relativized in context
  assert.ok(
    /nicht gefunden|Nachrichtenobjekt|Objekttyp/i.test(run.final_context) ||
      run.specialized_plan.primary_anchor?.user_object_type_guess === "nachricht",
    "user object-type guess / relativization present",
  );

  // Search trace
  assert.ok(run.search_trace.extracted_tokens?.includes("ZECD"));
  assert.ok((run.search_trace.exact_symbol_hits?.length ?? 0) >= 1);
  assert.ok(run.search_trace.primary_anchor?.symbol === "ZECD");

  console.log(
    JSON.stringify(
      {
        ok: true,
        extracted_tokens: run.search_trace.extracted_tokens,
        primary_anchor: run.search_trace.primary_anchor,
        exact_symbol_hits: run.search_trace.exact_symbol_hits?.slice(0, 8),
        discarded_semantic_hits:
          run.search_trace.discarded_semantic_hits?.slice(0, 8),
        evidence_passed_to_synthesis:
          run.search_trace.evidence_passed_to_synthesis?.slice(0, 12),
        zecd_objects: zecdObjects,
      },
      null,
      2,
    ),
  );
  console.log("zecdExactSymbol.regression.test.ts — OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
