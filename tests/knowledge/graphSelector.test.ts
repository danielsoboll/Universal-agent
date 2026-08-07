/**
 * Deterministic graph-selector ranking on a tiny in-memory fixture.
 */
import assert from "node:assert/strict";
import { selectCodeUnitsFromGraph } from "../../src/lib/knowledge/graphSelector/selectCodeUnits";
import type { LoadedGraph } from "../../src/lib/knowledge/graphSelector/loadGraph";
import type { CodeUnitIndex } from "../../src/lib/knowledge/graphSelector/loadGraph";
import type { CodeUnitRef, GraphEdge, GraphNode } from "../../src/lib/knowledge/graphSelector/types";

function node(
  partial: Partial<GraphNode> & Pick<GraphNode, "node_id" | "object_type" | "name">,
): GraphNode {
  return {
    identity_key: partial.name,
    system_id: "Q01",
    display_names: [partial.name],
    authoritative_existence: false,
    code_usage: false,
    attributes: {},
    ...partial,
  };
}

function edge(
  partial: Partial<GraphEdge> &
    Pick<GraphEdge, "from_node_id" | "to_node_id" | "relation_type">,
): GraphEdge {
  return {
    edge_id: `${partial.from_node_id}>${partial.to_node_id}`,
    relation_unified: partial.relation_type,
    occurrence_count: 1,
    evidence_class: "usage_relation",
    authoritative: false,
    ...partial,
  };
}

function ref(partial: CodeUnitRef): CodeUnitRef {
  return partial;
}

function main() {
  const nodes = new Map<string, GraphNode>();
  const nOut = node({
    node_id: "OUTPUT_TYPE|Q01|B|V1|ZECD",
    object_type: "OUTPUT_TYPE",
    name: "ZECD",
    identity_key: "B|V1|ZECD",
    authoritative_existence: true,
  });
  const nProg = node({
    node_id: "PROGRAM|Q01|Z_PROCESS_MESSAGE_ZECD",
    object_type: "PROGRAM",
    name: "Z_PROCESS_MESSAGE_ZECD",
  });
  const nMeth = node({
    node_id: "METHOD|Q01|ZCL_AUMO_ATP|SEND_ZECD",
    object_type: "METHOD",
    name: "SEND_ZECD",
    identity_key: "ZCL_AUMO_ATP|SEND_ZECD",
  });
  for (const n of [nOut, nProg, nMeth]) nodes.set(n.node_id, n);

  const edges = [
    edge({
      from_node_id: nOut.node_id,
      to_node_id: nProg.node_id,
      relation_type: "OUTPUT_TYPE_TO_PROGRAM",
      relation_unified: "OUTPUT_TYPE_PROCESSED_BY_PROGRAM",
      evidence_class: "authoritative_existence",
      authoritative: true,
      occurrence_count: 3,
    }),
    edge({
      from_node_id: nOut.node_id,
      to_node_id: nMeth.node_id,
      relation_type: "USES_METHOD",
      relation_unified: "USES_METHOD",
      evidence_class: "code_usage",
      occurrence_count: 1,
    }),
  ];

  const adjacency = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    for (const id of [e.from_node_id, e.to_node_id]) {
      const list = adjacency.get(id) ?? [];
      list.push(e);
      adjacency.set(id, list);
    }
  }

  const graph: LoadedGraph = { nodes, adjacency, edges };

  const methodRef = ref({
    source_key: "D01|CLASS|ZCL_AUMO_ATP|METHOD|SEND_ZECD",
    corpus: "classes",
    object_name: "ZCL_AUMO_ATP",
    unit_name: "SEND_ZECD",
    unit_type: "METHOD",
    object_type: "CLASS",
    content_hash: "hash1",
  });
  const progRef = ref({
    source_key: "Q01|PROGRAM|Z_PROCESS_MESSAGE_ZECD|PROGRAM|Z_PROCESS_MESSAGE_ZECD",
    corpus: "programs",
    object_name: "Z_PROCESS_MESSAGE_ZECD",
    unit_name: "Z_PROCESS_MESSAGE_ZECD",
    unit_type: "PROGRAM",
    object_type: "PROGRAM",
  });

  const bySourceKey = new Map([
    [methodRef.source_key, methodRef],
    [progRef.source_key, progRef],
  ]);
  const byObjectName = new Map<string, CodeUnitRef[]>([
    ["Z_PROCESS_MESSAGE_ZECD", [progRef]],
    ["ZCL_AUMO_ATP", [methodRef]],
  ]);
  const byUnitName = new Map<string, CodeUnitRef[]>([
    ["SEND_ZECD", [methodRef]],
    ["Z_PROCESS_MESSAGE_ZECD", [progRef]],
  ]);
  const byClassMethod = new Map<string, CodeUnitRef[]>([
    ["ZCL_AUMO_ATP|SEND_ZECD", [methodRef]],
  ]);

  const codeUnits: CodeUnitIndex = {
    bySourceKey,
    byObjectName,
    byUnitName,
    byClassMethod,
  };

  const result = selectCodeUnitsFromGraph({
    projectKey: "P01",
    question: "Was macht ZECD?",
    anchors: ["ZECD"],
    maxHops: 2,
    maxCodeUnits: 30,
    graph,
    codeUnits,
    analyses: new Map(),
  });

  assert.ok(result.seeds.length >= 1);
  assert.ok(result.selected.length >= 1);
  const classMethod = result.selected.find((s) => s.corpus === "classes");
  assert.ok(classMethod, "expected a class method in selection");
  assert.equal(classMethod!.would_need_openai, true);
  assert.ok(
    result.selected.some((s) => s.source_key.includes("SEND_ZECD")) ||
      result.selected.some((s) => s.source_key.includes("Z_PROCESS_MESSAGE_ZECD")),
  );
  assert.equal(result.evidence_coverage.expansion_over_cap_recommended, false);

  // Cap behaviour
  const capped = selectCodeUnitsFromGraph({
    projectKey: "P01",
    question: "Was macht ZECD?",
    anchors: ["ZECD"],
    maxHops: 2,
    maxCodeUnits: 1,
    graph,
    codeUnits,
    analyses: new Map(),
  });
  assert.equal(capped.selected.length, 1);
  assert.ok(capped.held_back.length >= 1);

  console.log("graphSelector.test.ts: OK");
}

main();
