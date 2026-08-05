/**
 * Regression + mode comparison:
 *   - Direkte Suche (direct_rag)
 *   - KI-Tiefensuche (deep_search)
 *
 *   npx tsx tests/knowledge/deepSearchCompare.regression.test.ts
 */
import assert from "assert";
import { resolve } from "path";
import { loadEnvFile } from "../../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../../src/lib/localData/root";
import { fileProjectRepository } from "../../src/lib/localAuth/projectRepository";
import { compareDirectAndDeepSearch } from "../../src/lib/knowledge/deepSearch/compareModes";
import { runQueryUnderstanding } from "../../src/lib/knowledge/deepSearch/queryUnderstanding";
import { selectSearchPlan } from "../../src/lib/knowledge/deepSearch/selectSearchPlan";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

const CASES = [
  {
    id: "vlager",
    question:
      "Bei Edeka wird beim Auftrag anscheinend über den Kundenstamm gesteuert, ob das virtuelle Lager greift. Wie funktioniert das genau?",
    expectIntent: ["VERIFY_AND_EXPLAIN_PROCESS", "PROCESS_EXPLANATION"],
    expectPlan: ["MASTER_FIELD_TO_PROCESS"],
    expectConcept: /virtuell|lager/i,
  },
  {
    id: "zecd",
    question: "Was wissen wir über die Nachricht ZECD?",
    expectIntent: ["ENTITY_LOOKUP"],
    expectPlan: ["TECHNICAL_SYMBOL_TO_PROCESS"],
    expectToken: "ZECD",
  },
] as const;

async function main() {
  const projects = await fileProjectRepository.list();
  const project =
    projects.find((p) => p.customer_id === "P01") ?? projects[0];
  assert.ok(project, "P01 required");

  const reports: unknown[] = [];

  for (const c of CASES) {
    console.error(`\n=== CASE ${c.id} ===`);
    const qu = await runQueryUnderstanding(c.question);
    const selected = selectSearchPlan(qu);

    assert.ok(
      (c.expectIntent as readonly string[]).includes(qu.intent),
      `${c.id}: intent=${qu.intent}`,
    );
    assert.ok(
      (c.expectPlan as readonly string[]).includes(qu.preferred_search_plan),
      `${c.id}: plan=${qu.preferred_search_plan}`,
    );
    if ("expectToken" in c && c.expectToken) {
      assert.ok(
        qu.technical_tokens.includes(c.expectToken),
        `${c.id}: missing token ${c.expectToken}`,
      );
      assert.ok(
        qu.assumed_object_types.some((a) => /message|nachricht/i.test(a.type)) ||
          qu.user_assumed_type,
        `${c.id}: assumed message type`,
      );
      assert.ok(
        (qu.assumed_type_confidence ?? "low") !== "high",
        "assumed type confidence must not be high",
      );
    }
    if ("expectConcept" in c && c.expectConcept) {
      assert.ok(
        qu.business_concepts.some((x) => c.expectConcept.test(x)) ||
          qu.original_question.match(c.expectConcept),
        `${c.id}: business concept`,
      );
      assert.ok(
        qu.user_hypotheses.some((h) => h.status === "TO_BE_VERIFIED"),
        `${c.id}: hypothesis TO_BE_VERIFIED`,
      );
    }

    const { comparison, direct, deep } = await compareDirectAndDeepSearch({
      project: project!,
      question: c.question,
      persist: true,
    });

    assert.strictEqual(direct.search_mode, "direct_rag");
    assert.strictEqual(deep.answer.search_mode, "deep_search");

    if (c.id === "zecd") {
      const deepText = deep.answer.direct_answer.toUpperCase();
      assert.ok(
        /ZECD/.test(deepText) ||
          deep.answer.technical_objects.some((o) => /ZECD/i.test(o)),
        "deep must mention ZECD objects",
      );
      assert.ok(
        !/^ZTMO_MESSAGES|ZPO_BA00/.test(
          deep.answer.sources[0]?.title ?? "",
        ),
        "deep top source must not be generic MESSAGE table",
      );
    }

    if (c.id === "vlager") {
      assert.ok(
        deep.query_understanding.preferred_search_plan ===
          "MASTER_FIELD_TO_PROCESS" ||
          deep.multi_source.specialized_plan.plan_type ===
            "MASTER_FIELD_TO_PROCESS" ||
          /ZZ_VLAGER|KNVV|virtuell/i.test(deep.answer.direct_answer),
        "vlager deep should pursue master-field / virtuelles Lager",
      );
    }

    reports.push({
      case: c.id,
      query_understanding: {
        intent: qu.intent,
        technical_tokens: qu.technical_tokens,
        business_concepts: qu.business_concepts,
        organization_context: qu.organization_context,
        process_context: qu.process_context,
        user_hypotheses: qu.user_hypotheses,
        assumed_object_types: qu.assumed_object_types,
        preferred_search_plan: qu.preferred_search_plan,
        search_plan_steps: qu.search_plan_steps,
        selected_plan_type: selected.plan_type,
        confidence: qu.confidence,
        warnings: qu.warnings,
      },
      comparison,
      direct_preview: {
        answer: direct.direct_answer.slice(0, 400),
        sources: direct.sources.slice(0, 5).map((s) => s.title),
        runtime_ms: direct.duration_ms,
        cost: direct.estimated_cost,
        tokens: direct.token_usage,
      },
      deep_preview: {
        answer: deep.answer.direct_answer.slice(0, 400),
        sources: deep.answer.sources.slice(0, 5).map((s) => s.title),
        objects: deep.answer.technical_objects.slice(0, 8),
        runtime_ms: deep.metrics.runtime_ms,
        cost: deep.metrics.cost,
        tokens: deep.metrics.tokens,
        evidence_count: deep.metrics.evidence_count,
        log_dir: deep.log_dir,
      },
    });
  }

  console.log(JSON.stringify({ ok: true, reports }, null, 2));
  console.log("deepSearchCompare.regression.test.ts — OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
