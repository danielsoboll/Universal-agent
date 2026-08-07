import assert from "node:assert/strict";
import { classifyEntityListIntent } from "../../src/lib/knowledge/entityListAggregation/classifyEntityListIntent";
import {
  aggregateEntityList,
  methodMatchesTopic,
  parseSourceKey,
} from "../../src/lib/knowledge/entityListAggregation/aggregateEntities";
import { classifyAskIntent } from "../../src/lib/knowledge/askOrchestration/classifyAskIntent";

function main() {
  const q = "Diese Klassen, die EDI Mapping machen – welche sind das?";
  const el = classifyEntityListIntent(q);
  assert.equal(el.intent, "ENTITY_LIST");
  assert.equal(el.requested_entity_type, "CLASS");
  assert.equal(el.topic, "EDI_MAPPING");

  const ask = classifyAskIntent(q);
  assert.equal(ask.intent, "ENTITY_LIST");

  const parsed = parseSourceKey(
    "D01|CLASS|ZCL_EDIMAP_OUT_DESADV|METHOD|ZIF_EDIFACT_PORT~MAPPING",
  );
  assert.equal(parsed.object_type, "CLASS");
  assert.equal(parsed.object_name, "ZCL_EDIMAP_OUT_DESADV");
  assert.equal(parsed.unit_name, "ZIF_EDIFACT_PORT~MAPPING");

  assert.equal(methodMatchesTopic("MAPPING", "EDI_MAPPING"), true);
  assert.equal(methodMatchesTopic("PRE_MAPPING", "EDI_MAPPING"), true);
  assert.equal(
    methodMatchesTopic("STYLEMAPPING_DYNAMIC_STYLE", "EDI_MAPPING"),
    false,
  );
  assert.equal(
    methodMatchesTopic("MAP_DISTANCE", "EDI_MAPPING", "ZCL_ABAPGIT_ZLIB"),
    false,
  );
  assert.equal(
    methodMatchesTopic("MAP_E1EDL20", "EDI_MAPPING", "ZCL_EDIMAP_OUT_DESADV"),
    true,
  );

  const { items, filtered_out } = aggregateEntityList({
    hits: [
      {
        source_key: "D01|CLASS|ZCL_EDIMAP_OUT_DESADV|METHOD|ZIF_EDIFACT_PORT~MAPPING",
        object_type: "CLASS",
        object_name: "ZCL_EDIMAP_OUT_DESADV",
        unit_type: "METHOD",
        unit_name: "ZIF_EDIFACT_PORT~MAPPING",
        distance: 0,
        path_relations: [],
        summary: null,
        cache_hit: true,
      },
      {
        source_key:
          "D01|CLASS|ZCL_EDIMAP_OUT_DESADV|METHOD|ZIF_EDIFACT_PORT~PRE_MAPPING",
        object_type: "CLASS",
        object_name: "ZCL_EDIMAP_OUT_DESADV",
        unit_type: "METHOD",
        unit_name: "ZIF_EDIFACT_PORT~PRE_MAPPING",
        distance: 0,
        path_relations: [],
        summary: null,
        cache_hit: true,
      },
      {
        source_key:
          "D01|CLASS|ZCL_EDIMAP_OUT_DESADV|METHOD|ZIF_EDIFACT_PORT~POST_MAPPING",
        object_type: "CLASS",
        object_name: "ZCL_EDIMAP_OUT_DESADV",
        unit_type: "METHOD",
        unit_name: "ZIF_EDIFACT_PORT~POST_MAPPING",
        distance: 0,
        path_relations: [],
        summary: null,
        cache_hit: true,
      },
      {
        source_key: "Q01|FUNCTION_MODULE|ZEDIFACT_MAPPING|FUNCTION|ZEDIFACT_MAPPING",
        object_type: "FUNCTION_MODULE",
        object_name: "ZEDIFACT_MAPPING",
        unit_type: "FUNCTION",
        unit_name: "ZEDIFACT_MAPPING",
        distance: 0,
        path_relations: [],
        summary: null,
        cache_hit: false,
      },
    ],
    requested_entity_type: "CLASS",
    topic: "EDI_MAPPING",
    authoritative_nodes: ["LOGICAL_SYSTEM:EDIESEDI"],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]!.entity_name, "ZCL_EDIMAP_OUT_DESADV");
  assert.equal(items[0]!.role, "PRIMARY");
  assert.equal(items[0]!.matched_methods.length, 3);
  assert.ok(filtered_out.some((f) => f.name === "ZEDIFACT_MAPPING"));
  assert.ok(filtered_out.some((f) => f.name === "EDIESEDI"));

  console.log("entityListAggregation smoke OK");
}

main();
