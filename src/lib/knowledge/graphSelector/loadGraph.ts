/**
 * Load knowledge-graph nodes/edges and code-unit indexes for selection.
 */
import { existsSync, readFileSync } from "fs";
import { streamJsonlObjects } from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import { resolveWritablePath } from "@/lib/localData/paths";
import { hashUnitContent } from "@/lib/analysis/analyzeCodeUnits";
import type {
  CodeUnitCorpus,
  CodeUnitRef,
  GraphEdge,
  GraphEvidenceClass,
  GraphNode,
} from "@/lib/knowledge/graphSelector/types";

export type LoadedGraph = {
  nodes: Map<string, GraphNode>;
  /** adjacency: node_id → edges touching the node */
  adjacency: Map<string, GraphEdge[]>;
  edges: GraphEdge[];
};

export type CodeUnitIndex = {
  bySourceKey: Map<string, CodeUnitRef>;
  /** UPPER object_name → refs */
  byObjectName: Map<string, CodeUnitRef[]>;
  /** UPPER unit_name → refs */
  byUnitName: Map<string, CodeUnitRef[]>;
  /** UPPER `CLASS|METHOD` → refs */
  byClassMethod: Map<string, CodeUnitRef[]>;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asBool(v: unknown): boolean {
  return v === true;
}

function evidenceClass(v: unknown): GraphEvidenceClass {
  const s = asString(v);
  if (
    s === "authoritative_existence" ||
    s === "authoritative_config" ||
    s === "usage_relation" ||
    s === "code_usage" ||
    s === "unresolved"
  ) {
    return s;
  }
  return "unknown";
}

export async function loadKnowledgeGraph(
  projectKey: string,
): Promise<LoadedGraph> {
  const nodesPath = resolveWritablePath(
    projectKey,
    "canonical",
    "knowledge-graph",
    "nodes.jsonl",
  );
  const edgesPath = resolveWritablePath(
    projectKey,
    "canonical",
    "knowledge-graph",
    "edges.jsonl",
  );

  const nodes = new Map<string, GraphNode>();
  for await (const raw of streamJsonlObjects(nodesPath)) {
    const node_id = asString(raw.node_id);
    if (!node_id) continue;
    const evidence =
      raw.evidence && typeof raw.evidence === "object" && !Array.isArray(raw.evidence)
        ? (raw.evidence as Record<string, unknown>)
        : {};
    nodes.set(node_id, {
      node_id,
      object_type: asString(raw.object_type).toUpperCase(),
      name: asString(raw.name),
      identity_key: asString(raw.identity_key),
      system_id: asString(raw.system_id),
      display_names: Array.isArray(raw.display_names)
        ? raw.display_names.map((x) => asString(x)).filter(Boolean)
        : [],
      authoritative_existence: asBool(evidence.authoritative_existence),
      code_usage: asBool(evidence.code_usage),
      attributes:
        raw.attributes &&
        typeof raw.attributes === "object" &&
        !Array.isArray(raw.attributes)
          ? (raw.attributes as Record<string, unknown>)
          : {},
    });
  }

  const edges: GraphEdge[] = [];
  const adjacency = new Map<string, GraphEdge[]>();
  const pushAdj = (id: string, e: GraphEdge) => {
    const list = adjacency.get(id);
    if (list) list.push(e);
    else adjacency.set(id, [e]);
  };

  for await (const raw of streamJsonlObjects(edgesPath)) {
    const from_node_id = asString(raw.from_node_id);
    const to_node_id = asString(raw.to_node_id);
    if (!from_node_id || !to_node_id) continue;
    const edge: GraphEdge = {
      edge_id: asString(raw.edge_id) || `${from_node_id}>${to_node_id}`,
      from_node_id,
      to_node_id,
      relation_type: asString(raw.relation_type),
      relation_unified: asString(raw.relation_unified) || asString(raw.relation_type),
      occurrence_count: Number(raw.occurrence_count) || 1,
      evidence_class: evidenceClass(raw.evidence_class),
      authoritative: asBool(raw.authoritative),
    };
    edges.push(edge);
    pushAdj(from_node_id, edge);
    pushAdj(to_node_id, edge);
  }

  return { nodes, adjacency, edges };
}

const CORPUS_FILES: Array<{ corpus: CodeUnitCorpus; rel: string }> = [
  { corpus: "classes", rel: "classes/code_units.jsonl" },
  { corpus: "programs", rel: "programs/code_units.jsonl" },
  { corpus: "function-modules", rel: "function-modules/code_units.jsonl" },
];

function pushIndex(
  map: Map<string, CodeUnitRef[]>,
  key: string,
  ref: CodeUnitRef,
) {
  const k = key.trim().toUpperCase();
  if (!k) return;
  const list = map.get(k);
  if (list) list.push(ref);
  else map.set(k, [ref]);
}

export async function loadCodeUnitIndex(
  projectKey: string,
  opts?: { includeSourceCode?: boolean },
): Promise<CodeUnitIndex> {
  const includeSourceCode = opts?.includeSourceCode ?? false;
  const bySourceKey = new Map<string, CodeUnitRef>();
  const byObjectName = new Map<string, CodeUnitRef[]>();
  const byUnitName = new Map<string, CodeUnitRef[]>();
  const byClassMethod = new Map<string, CodeUnitRef[]>();

  for (const { corpus, rel } of CORPUS_FILES) {
    const abs = resolveWritablePath(projectKey, "canonical", rel);
    if (!existsSync(abs)) continue;
    for await (const raw of streamJsonlObjects(abs)) {
      if (asString(raw.record_type ?? "code_unit") !== "code_unit") continue;
      const source_key = asString(raw.source_key);
      if (!source_key || bySourceKey.has(source_key)) continue;
      const object_name = asString(raw.object_name);
      const unit_name = asString(raw.unit_name);
      const unit_type = asString(raw.unit_type).toUpperCase();
      const object_type = asString(raw.object_type).toUpperCase();
      const source_code =
        typeof raw.source_code === "string" ? raw.source_code : undefined;
      const ref: CodeUnitRef = {
        source_key,
        corpus,
        object_name,
        unit_name,
        unit_type,
        object_type,
        content_hash:
          includeSourceCode && source_code
            ? hashUnitContent(source_code)
            : undefined,
        source_code: includeSourceCode ? source_code : undefined,
      };
      bySourceKey.set(source_key, ref);
      pushIndex(byObjectName, object_name, ref);
      pushIndex(byUnitName, unit_name, ref);
      if (corpus === "classes" && object_name && unit_name) {
        pushIndex(byClassMethod, `${object_name}|${unit_name}`, ref);
      }
    }
  }

  return { bySourceKey, byObjectName, byUnitName, byClassMethod };
}

export function loadClassAnalysesMap(
  projectKey: string,
): Map<string, Record<string, unknown>> {
  const abs = resolveWritablePath(
    projectKey,
    "analyses",
    "classes/unit_analyses.jsonl",
  );
  const map = new Map<string, Record<string, unknown>>();
  if (!existsSync(abs)) return map;
  for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const key = asString(o.source_key);
      if (key) map.set(key, o);
    } catch {
      /* skip */
    }
  }
  return map;
}
