import assert from "node:assert/strict";
import {
  applyOrchestrationRelevanceGate,
  identifyStrongSeedObjects,
  normalizeQueryTerms,
  queryTermCoverage,
} from "../../src/lib/knowledge/askOrchestration/orchestrationRelevanceGate";
import type { GraphFirstRetrieval } from "../../src/lib/knowledge/askOrchestration/graphFirstRetrieval";

function main() {
  const terms = normalizeQueryTerms([
    "Edeka",
    "virtuelle",
    "virtue",
    "virtuell",
    "Lager",
  ]);
  assert.deepEqual(terms, ["VIRTUELLE", "EDEKA", "LAGER"]);

  assert.equal(
    queryTermCoverage("ZCL_VIRTUELLES_LAGER", terms),
    2,
  );
  assert.equal(queryTermCoverage("ZCL_EDEKA_BELEGLOG", terms), 1);
  assert.equal(queryTermCoverage("ZIDOC_EDEKA_BW", terms), 1);

  const strong = identifyStrongSeedObjects({
    graph_paths: [
      {
        source_key: "D01|CLASS|ZCL_VIRTUELLES_LAGER|METHOD|CHECK",
        object_name: "ZCL_VIRTUELLES_LAGER",
        unit_name: "CHECK",
        distance: 0,
        path_relations: [],
        cache_status: "miss",
        would_need_openai: false,
      },
      {
        source_key: "D01|CLASS|ZCL_EDEKA_BELEGLOG|METHOD|BUILD",
        object_name: "ZCL_EDEKA_BELEGLOG",
        unit_name: "BUILD",
        distance: 0,
        path_relations: [],
        cache_status: "miss",
        would_need_openai: false,
      },
    ],
    technical_symbols: [],
    query_terms: terms,
  });
  assert.deepEqual(strong, ["ZCL_VIRTUELLES_LAGER"]);

  const graph: GraphFirstRetrieval = {
    seeds: terms,
    graph_paths: [
      {
        source_key: "D01|CLASS|ZCL_VIRTUELLES_LAGER|METHOD|CHECK_LFPOS_FOR_VLAGER",
        object_name: "ZCL_VIRTUELLES_LAGER",
        unit_name: "CHECK_LFPOS_FOR_VLAGER",
        distance: 0,
        path_relations: [],
        cache_status: "miss",
        would_need_openai: false,
      },
      {
        source_key: "D01|CLASS|ZCL_EDEKA_BELEGLOG|METHOD|BUILD_LOG",
        object_name: "ZCL_EDEKA_BELEGLOG",
        unit_name: "BUILD_LOG",
        distance: 0,
        path_relations: [],
        cache_status: "hit",
        would_need_openai: false,
      },
    ],
    cached_analyses: [],
    relation_hops: null,
    authoritative_nodes: [
      "IDOC_TYPE:ZIDOC_EDEKA_BW",
      "LOGICAL_SYSTEM:EDIEDEKAHH",
      "MESSAGE_TYPE:Z1EDEKA_BW_INFO",
      "PARTNER_PROFILE:LS|EDIEDEKAHH",
      "IDOC_SEGMENT:Z1EDEKA_KAMPAGNEN",
    ],
    code_usage_nodes: [],
    canonical_sources: [],
    selector: null,
    new_analyses_attempted: 0,
    duration_ms: 0,
  };

  const gate = applyOrchestrationRelevanceGate({
    intent: "PROCESS_EXPLANATION",
    query_terms: terms,
    technical_symbols: [],
    graph,
    method_symbol_names: [
      "AND KNVV~ZZ_VLAGER IN @ME->VLAGER",
      "IF cs_likp-zz_vlager IS NOT INITIAL",
    ],
  });

  assert.ok(gate.strong_seeds.includes("ZCL_VIRTUELLES_LAGER"));
  assert.equal(
    gate.filtered_graph_paths.some((p) =>
      p.object_name.includes("VIRTUELLES_LAGER"),
    ),
    true,
  );
  assert.equal(
    gate.filtered_graph_paths.some((p) =>
      p.object_name.includes("EDEKA_BELEGLOG"),
    ),
    false,
  );
  assert.ok(
    gate.excluded_shared_token_only.some((x) => /EDEKA|IDOC|LOGICAL|MESSAGE|PARTNER|KAMPAG/i.test(x)),
  );
  assert.ok(
    gate.field_refs.some((f) => /KNVV-ZZ_VLAGER/i.test(f.object_name)),
  );
  assert.equal(
    gate.field_refs.some((f) => /EDEKA-SUPPORT|LINE-PERNR|CONSTANTS-/i.test(f.object_name)),
    false,
  );
  assert.equal(gate.filtered_authoritative_nodes.length, 0);

  console.log("orchestrationRelevanceGate smoke OK");
}

main();
