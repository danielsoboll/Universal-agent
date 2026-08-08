/**
 * Pipeline trace for Direct-RAG seed/budget/gate/context stages.
 *
 *   npx tsx scripts/debug-seed-evidence-gate.ts --project P01 --query "..."
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveAskLocalProject } from "../src/lib/knowledge/resolveAskProject";
import { KnowledgeRetriever } from "../src/lib/knowledge/knowledgeRetriever";
import {
  extractQueryEntities,
  groundQueryEntities,
} from "../src/lib/knowledge/entityGrounding";
import {
  assessRelevanceGate,
  hitsByIds,
} from "../src/lib/knowledge/relevanceGate";
import {
  hasDeterministicSeedEvidence,
  mergePreserveConfirmedSeedEvidence,
  enrichmentPackToHits,
} from "../src/lib/knowledge/seedEnrichment";
import { resolveProjectCapabilities } from "../src/lib/domain/capabilities";
import { decideSearchBudgetAfterLocalExact } from "../src/lib/knowledge/searchBudget";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function hitBrief(h: {
  rank: number;
  search_document_id: string;
  title: string;
  knowledge_unit_type?: string | null;
  matched_terms?: string[];
  facts?: string[];
  exact_score?: number;
}) {
  return {
    rank: h.rank,
    id: h.search_document_id,
    title: (h.title ?? "").slice(0, 100),
    kut: h.knowledge_unit_type ?? "",
    exact: h.exact_score ?? 0,
    seed: hasDeterministicSeedEvidence(h as never),
    facts_preview: (h.facts ?? []).slice(0, 2),
  };
}

function markerScan(hits: { title?: string; facts?: string[]; technical_summary?: string }[]) {
  const blob = hits
    .map(
      (h) =>
        `${h.title ?? ""}\n${(h.facts ?? []).join("\n")}\n${h.technical_summary ?? ""}`,
    )
    .join("\n")
    .toUpperCase();
  return {
    ZZ_VLAGER: blob.includes("ZZ_VLAGER"),
    KNVV: blob.includes("KNVV"),
    ZCL_VIRTUELLES_LAGER: blob.includes("ZCL_VIRTUELLES_LAGER"),
    customer_names:
      /EDEKA|KRAMPS|JANSSEN|KUNNR|NAME1|VERTRIEBSBEREICH/i.test(blob),
    instance_count: /\b1645\b/.test(blob) || /IST BEI [1-9]/.test(blob),
  };
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const argv = process.argv.slice(2);
  const query = argValue(argv, "--query")?.trim();
  if (!query) {
    console.error("--query ist erforderlich");
    process.exit(2);
  }
  const projectRef = argValue(argv, "--project")?.trim() || "P01";
  const resolved = await resolveAskLocalProject(projectRef);
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(2);
  }
  const project = resolved.project;
  const capabilities = resolveProjectCapabilities(project);

  // Stage 0: same as direct_rag LOCAL_EXACT (no vector)
  const local = await KnowledgeRetriever.search({
    project,
    query,
    limit: 12,
    searchProfile: capabilities.searchProfile,
    enableVector: false,
  });

  const initial = local.hits;
  const pack = local.seed_enrichment;
  const enrichHits = pack?.enriched ? enrichmentPackToHits(pack, 1) : [];
  const preservedSeed = mergePreserveConfirmedSeedEvidence(initial, [
    ...enrichHits,
    ...initial,
  ]);

  const budget = decideSearchBudgetAfterLocalExact({
    question: query,
    searchMode: "direct_rag",
    localHits: preservedSeed,
    literalMiss: Boolean(local.access_index?.literal_miss),
  });

  const afterBudget = mergePreserveConfirmedSeedEvidence(
    budget.hits,
    preservedSeed,
  );

  const grounding = groundQueryEntities({
    queryEntities: extractQueryEntities(query, null),
    hits: afterBudget,
  });
  const gate = assessRelevanceGate({
    question: query,
    hits: afterBudget,
    grounding,
    domainProfile: capabilities.domainProfile,
  });

  const afterGate =
    gate.supporting_source_ids.length > 0
      ? hitsByIds(afterBudget, gate.supporting_source_ids)
      : afterBudget;
  const finalContext = mergePreserveConfirmedSeedEvidence(
    afterGate,
    afterBudget,
  );

  const out = {
    query,
    stages: {
      initial_candidates: {
        count: initial.length,
        top: initial.slice(0, 12).map(hitBrief),
        markers: markerScan(initial),
      },
      preserved_seed_enrichment: {
        confirmed_seeds: (pack?.field_enrichments ?? []).map((e) => ({
          seed: e.seed.seed,
          instances: e.master_instances.total_attributes,
          code_links: e.code_usage.total,
          sample_names: e.master_instances.samples
            .slice(0, 3)
            .map((s) => s.name1)
            .filter(Boolean),
        })),
        notes: pack?.notes ?? [],
        count: preservedSeed.filter(hasDeterministicSeedEvidence).length,
        docs: preservedSeed.filter(hasDeterministicSeedEvidence).map(hitBrief),
        markers: markerScan(preservedSeed),
      },
      after_search_budget: {
        stage: budget.stage,
        count: afterBudget.length,
        seed_count: afterBudget.filter(hasDeterministicSeedEvidence).length,
        top: afterBudget.slice(0, 12).map(hitBrief),
        markers: markerScan(afterBudget),
      },
      after_relevance_gate: {
        answerability: gate.answerability,
        matched_concepts: gate.matched_concepts,
        missing_concepts: gate.missing_concepts,
        reason: gate.reason,
        supporting_seed_ids: gate.supporting_source_ids.filter((id) =>
          id.startsWith("enrichment:"),
        ),
        count: afterGate.length,
        top: afterGate.slice(0, 12).map(hitBrief),
        markers: markerScan(afterGate),
      },
      final_llm_context: {
        count: finalContext.length,
        top: finalContext.slice(0, 16).map(hitBrief),
        markers: markerScan(finalContext),
      },
    },
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
