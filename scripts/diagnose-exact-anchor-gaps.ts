/**
 * Diagnosis-only: Direct-RAG exact-anchor gap traces (no LLM).
 *
 *   npx tsx scripts/diagnose-exact-anchor-gaps.ts
 */
import { resolve } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveAskLocalProject } from "../src/lib/knowledge/resolveAskProject";
import { KnowledgeRetriever } from "../src/lib/knowledge/knowledgeRetriever";
import { resolveProjectCapabilities } from "../src/lib/domain/capabilities";
import { decideSearchBudgetAfterLocalExact } from "../src/lib/knowledge/searchBudget";
import { namedEntityTechnicalAnchors } from "../src/lib/knowledge/searchBudget/extractNamedExternalEntity";
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
import { searchViaAccessIndexes } from "../src/lib/portableIndex/accessIndexSearch";
import { normalizeLexicalQuery } from "../src/lib/search/lexical/normalizeQuery";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

function brief(h: {
  rank?: number;
  search_document_id?: string;
  title?: string;
  knowledge_unit_type?: string | null;
  object_type?: string | null;
  exact_score?: number;
  matched_terms?: string[];
  facts?: string[];
  technical_summary?: string;
}) {
  return {
    rank: h.rank,
    id: String(h.search_document_id ?? "").slice(0, 90),
    title: String(h.title ?? "").slice(0, 110),
    kut: h.knowledge_unit_type,
    ot: h.object_type,
    exact: h.exact_score,
    terms: (h.matched_terms ?? []).slice(0, 10),
    seed: hasDeterministicSeedEvidence(h as never),
    exact_authoritative: Boolean(
      (h as { metadata?: { exact_authoritative?: boolean } }).metadata
        ?.exact_authoritative,
    ),
    facts_preview: (h.facts ?? []).slice(0, 2),
  };
}

function hist(hits: { knowledge_unit_type?: string | null }[]) {
  const m: Record<string, number> = {};
  for (const h of hits) {
    const k = h.knowledge_unit_type || "?";
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function markers(
  hits: {
    title?: string;
    facts?: string[];
    technical_summary?: string;
    object_name?: string;
    source_key?: string;
  }[],
  keys: string[],
) {
  const blob = hits
    .map(
      (h) =>
        `${h.title}\n${h.object_name}\n${h.source_key}\n${(h.facts ?? []).join("\n")}\n${h.technical_summary ?? ""}`,
    )
    .join("\n")
    .toUpperCase();
  return Object.fromEntries(keys.map((k) => [k, blob.includes(k.toUpperCase())]));
}

async function trace(query: string, markerKeys: string[]) {
  const resolved = await resolveAskLocalProject("P01");
  if (!resolved.ok) throw new Error(resolved.message);
  const project = resolved.project;
  const capabilities = resolveProjectCapabilities(project);
  const anchors = namedEntityTechnicalAnchors(query);
  const norm = normalizeLexicalQuery(query);

  const access = searchViaAccessIndexes({ project, query, limit: 48 });
  const local = await KnowledgeRetriever.search({
    project,
    query,
    limit: 12,
    searchProfile: capabilities.searchProfile,
    enableVector: false,
  });

  const pack = local.seed_enrichment ?? access?.seed_enrichment;
  const enrichHits = pack?.enriched ? enrichmentPackToHits(pack, 1) : [];
  const preserved = mergePreserveConfirmedSeedEvidence(local.hits, [
    ...enrichHits,
    ...local.hits,
  ]);
  const budget = decideSearchBudgetAfterLocalExact({
    question: query,
    searchMode: "direct_rag",
    localHits: preserved,
    literalMiss: Boolean(local.access_index?.literal_miss),
  });
  const afterBudget = mergePreserveConfirmedSeedEvidence(budget.hits, preserved);
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
  const finalCtx = mergePreserveConfirmedSeedEvidence(afterGate, afterBudget);

  return {
    query,
    normalized_lexical: norm,
    technical_anchors: anchors,
    access_path: access?.primary_path,
    indexes_used: access?.indexes_used,
    graph_used: access?.graph_used,
    warnings: [...(access?.warnings ?? []), ...(local.warnings ?? [])].slice(0, 25),
    seed_notes: pack?.notes?.slice(0, 12) ?? [],
    kut_hist_access: hist(access?.hits ?? []),
    kut_hist_local12: hist(local.hits),
    kut_hist_budget: hist(afterBudget),
    kut_hist_final: hist(finalCtx),
    stages: {
      access_hits: {
        count: access?.hits.length ?? 0,
        top: (access?.hits ?? []).slice(0, 24).map(brief),
        markers: markers(access?.hits ?? [], markerKeys),
      },
      local_limit12: {
        count: local.hits.length,
        top: local.hits.slice(0, 16).map(brief),
        markers: markers(local.hits, markerKeys),
      },
      after_budget: {
        stage: budget.stage,
        count: afterBudget.length,
        top: afterBudget.slice(0, 16).map(brief),
        markers: markers(afterBudget, markerKeys),
      },
      after_gate: {
        answerability: gate.answerability,
        matched: gate.matched_concepts,
        missing: gate.missing_concepts,
        reason: gate.reason,
        count: afterGate.length,
        top: afterGate.slice(0, 16).map(brief),
        markers: markers(afterGate, markerKeys),
      },
      final_context: {
        count: finalCtx.length,
        top: finalCtx.slice(0, 20).map(brief),
        markers: markers(finalCtx, markerKeys),
      },
    },
  };
}

async function main() {
  const out = {
    octopus: await trace("Wie funktioniert die Kommunikation mit OCTOPUS?", [
      "OCTOPUS",
      "EDIOCTOPUS",
      "PARTNER",
      "LOGICAL",
      "IDOC",
      "SYNCHRON",
      "ZCSVFILE",
      "ORDERS",
    ]),
    zecd: await trace("Was wissen wir über ZECD?", [
      "ZECD",
      "CHECK_ZECD",
      "SEND_ZECD",
      "MESSAGE",
      "IDOC",
      "OUTPUT",
      "NACHRICHT",
    ]),
    vlager: await trace("Wie funktioniert das Edeka virtuelle Lager?", [
      "ZZ_VLAGER",
      "KNVV",
      "ZZTVAG",
      "ZCL_VIRTUELLES",
      "VLAGER",
      "ZDIS",
      "ZSD_",
    ]),
  };

  mkdirSync("tmp/regression", { recursive: true });
  const path = "tmp/regression/diag-exact-anchor-gaps.json";
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ wrote: path, ok: true }, null, 2));
  for (const [k, v] of Object.entries(out)) {
    const s = v.stages;
    console.log(
      JSON.stringify(
        {
          case: k,
          anchors: v.technical_anchors,
          access_path: v.access_path,
          graph_used: v.graph_used,
          kut_access: v.kut_hist_access,
          kut_final: v.kut_hist_final,
          budget_stage: s.after_budget.stage,
          gate: s.after_gate.answerability,
          missing: s.after_gate.missing,
          markers_access: s.access_hits.markers,
          markers_final: s.final_context.markers,
          top3: s.access_hits.top.slice(0, 3).map((h) => h.title),
        },
        null,
        2,
      ),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
