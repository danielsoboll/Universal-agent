/**
 * Relation Expansion — load inbound/outbound edges for primary anchors.
 * Max 2 hops. Dedupes. Maps legacy kinds → unified schema.
 * Sources: programs, FMs, classes, message-idoc, control-tables.
 */
import { existsSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  asString,
  streamJsonlObjects,
  streamJsonlObjectsMatching,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import {
  mapEntityReferenceRelation,
  mapLegacyRelation,
} from "./relationCatalog";
import type {
  EvidenceGraphEdge,
  EvidenceGraphNode,
  GraphNodeType,
  GraphRelationKind,
} from "./types";

type RawEdge = {
  from: string;
  to: string;
  relation: GraphRelationKind;
  source_path: string;
  confidence: number;
  evidence: string[];
  from_type?: GraphNodeType;
  to_type?: GraphNodeType;
};

function edgeKey(e: Pick<EvidenceGraphEdge, "from" | "relation" | "to">): string {
  return `${e.from}|${e.relation}|${e.to}`;
}

function nodeId(type: GraphNodeType, name: string): string {
  return `node:${type}:${name}`;
}

function inferNodeType(
  name: string,
  hint?: string | null,
): GraphNodeType {
  const h = (hint ?? "").toUpperCase();
  if (h.includes("OUTPUT")) return "OUTPUT_TYPE";
  if (h.includes("MESSAGE") || h.includes("ALE")) return "MESSAGE_TYPE";
  if (h.includes("IDOC")) return "IDOC_TYPE";
  if (h.includes("PARTNER")) return "PARTNER_PROFILE";
  if (h.includes("PROCESS")) return "PROCESS_CODE";
  if (h.includes("PORT")) return "PORT";
  if (h.includes("FUNCTION") || h.includes("FUGR")) return "FUNCTION_MODULE";
  if (h.includes("FORM")) return "FORM_ROUTINE";
  if (h.includes("INCLUDE")) return "INCLUDE";
  if (h.includes("CLASS") || h.includes("METHOD")) return "CLASS";
  if (h.includes("PROGRAM") || h.includes("EXTERNAL")) return "PROGRAM";
  if (h.includes("TABLE") || h.includes("CONTROL")) return "CONTROL_TABLE";
  if (/^[ZY]/i.test(name) && name.length > 3) return "PROGRAM";
  return "TECHNICAL_SYMBOL";
}

async function loadMatchingEdges(params: {
  abs: string;
  pathHint: string;
  seeds: Set<string>;
  maxEdges: number;
  fromKeys: string[];
  toKeys: string[];
  relationKey: string;
  typeFromKey?: string;
  typeToKey?: string;
  /** Prefer line-prefilter (faster for large relation corpora). */
  focused?: boolean;
}): Promise<RawEdge[]> {
  const out: RawEdge[] = [];
  if (!existsSync(params.abs) || params.seeds.size === 0) return out;
  const seedU = [...params.seeds]
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length >= 2);
  if (seedU.length === 0) return out;

  const stream = params.focused
    ? streamJsonlObjectsMatching(
        params.abs,
        // Prefilter: short seeds still need line contains; long seeds as-is
        seedU,
      )
    : streamJsonlObjects(params.abs);

  let scanned = 0;
  for await (const rec of stream) {
    scanned += 1;
    if (scanned > 250_000 || out.length >= params.maxEdges) break;

    const from =
      params.fromKeys.map((k) => asString(rec[k])).find(Boolean) || "";
    const to = params.toKeys.map((k) => asString(rec[k])).find(Boolean) || "";

    const fromU = from.toUpperCase();
    const toU = to.toUpperCase();
    const seedHit = seedU.some((su) => {
      // Short technical symbols: exact endpoint match only (avoid ZECD ⊂ ZZ_PROCESS_V1_ZECD fan-out)
      if (su.length <= 5) {
        return fromU === su || toU === su;
      }
      return (
        fromU === su ||
        toU === su ||
        (fromU.length > 0 && fromU.includes(su)) ||
        (toU.length > 0 && toU.includes(su))
      );
    });
    if (!seedHit) continue;

    const rawRel =
      asString(rec[params.relationKey]) ||
      asString(rec.relation_type) ||
      asString(rec.relation_kind) ||
      "RELATED";
    let relation = mapLegacyRelation(rawRel);

    if (rawRel === "ROW_REFERENCES_ENTITY") {
      const ent =
        asString(rec.entity_type) ||
        asString(
          (rec.attributes as Record<string, unknown> | undefined)?.entity_type as
            | string
            | undefined,
        );
      const specialized = mapEntityReferenceRelation(ent);
      if (specialized) relation = specialized;
    }

    const fromTypeHint = params.typeFromKey
      ? asString(rec[params.typeFromKey])
      : asString(rec.from_object_type) || asString(rec.from_type);
    const toTypeHint = params.typeToKey
      ? asString(rec[params.typeToKey])
      : asString(rec.to_object_type) || asString(rec.to_type);

    const fromMissing = !from || from === "?";
    const toMissing = !to || to === "?";
    if (fromMissing && toMissing) continue;

    out.push({
      from: fromMissing ? "?" : from,
      to: toMissing ? "?" : to,
      relation,
      source_path: params.pathHint,
      confidence: fromMissing || toMissing ? 0.25 : 0.75,
      evidence: [
        `${params.pathHint}:${rawRel}`,
        ...(fromMissing || toMissing ? ["endpoint_unresolved"] : []),
      ],
      from_type: inferNodeType(fromMissing ? "?" : from, fromTypeHint),
      to_type: inferNodeType(toMissing ? "?" : to, toTypeHint),
    });
  }
  return out;
}

export type RelationExpansionResult = {
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
  seeds_used: string[];
  hops: number;
  duration_ms: number;
};

export async function expandRelations(params: {
  projectKey: string;
  /** Primary / secondary anchor strings (names, object ids). */
  seeds: string[];
  maxHops?: number;
  maxEdgesPerHop?: number;
  /**
   * Fast / exact-symbol mode: only code + message-idoc relation files.
   * Skips huge control-table / class-analysis corpora.
   */
  focused?: boolean;
}): Promise<RelationExpansionResult> {
  const started = Date.now();
  const maxHops = Math.min(params.maxHops ?? 2, 2);
  const maxEdgesPerHop = params.maxEdgesPerHop ?? (params.focused ? 80 : 400);

  const nodeMap = new Map<string, EvidenceGraphNode>();
  const edgeMap = new Map<string, EvidenceGraphEdge>();
  let frontier = new Set(
    params.seeds.map((s) => s.trim()).filter((s) => s.length >= 2),
  );
  const seedsUsed = [...frontier];

  const corpora = (projectKey: string) => {
    const z = (parts: string[]) =>
      resolveProjectZonePath(projectKey, "canonical", ...parts);
    const core = [
      {
        abs: z(["programs", "relations.jsonl"]),
        pathHint: "canonical/programs/relations.jsonl",
        fromKeys: [
          "from_object",
          "source_object",
          "from_name",
          "from",
          "object_name",
        ],
        toKeys: ["to_object", "target_object", "to_name", "to"],
        relationKey: "relation_type",
      },
      {
        abs: z(["function-modules", "relations.jsonl"]),
        pathHint: "canonical/function-modules/relations.jsonl",
        fromKeys: [
          "from_object",
          "source_object",
          "from_name",
          "from",
          "object_name",
        ],
        toKeys: ["to_object", "target_object", "to_name", "to"],
        relationKey: "relation_type",
      },
      {
        abs: z(["message-idoc-config", "relations.jsonl"]),
        pathHint: "canonical/message-idoc-config/relations.jsonl",
        fromKeys: ["from_object_id", "from_name", "from"],
        toKeys: ["to_object_id", "to_name", "to"],
        relationKey: "relation_type",
        typeFromKey: "from_type",
        typeToKey: "to_type",
      },
      {
        abs: z(["message-idoc-config", "relations.from-groups-01-10.jsonl"]),
        pathHint:
          "canonical/message-idoc-config/relations.from-groups-01-10.jsonl",
        fromKeys: ["from_object_id", "from_name", "from"],
        toKeys: ["to_object_id", "to_name", "to"],
        relationKey: "relation_kind",
        typeFromKey: "from_object_type",
        typeToKey: "to_object_type",
      },
      {
        abs: z(["repository-relations", "relations.jsonl"]),
        pathHint: "canonical/repository-relations/relations.jsonl",
        fromKeys: ["from_name", "from"],
        toKeys: ["to_name", "to"],
        relationKey: "relation_type",
        typeFromKey: "from_type",
        typeToKey: "to_type",
      },
      {
        abs: z(["repository-relations", "unresolved.jsonl"]),
        pathHint: "canonical/repository-relations/unresolved.jsonl",
        fromKeys: ["from_name", "from"],
        toKeys: ["to_name", "to"],
        relationKey: "relation_type",
        typeFromKey: "from_type",
        typeToKey: "to_type",
      },
    ] as const;

    if (params.focused) return [...core];

    return [
      ...core,
      {
        abs: z(["classes", "relations.jsonl"]),
        pathHint: "canonical/classes/relations.jsonl",
        fromKeys: ["from_object", "from", "object_name"],
        toKeys: ["to_object", "to", "to_name"],
        relationKey: "relation_type",
      },
      {
        abs: z(["control-tables", "table_relations.jsonl"]),
        pathHint: "canonical/control-tables/table_relations.jsonl",
        fromKeys: ["from_id", "from_object", "from", "table_name"],
        toKeys: ["to_id", "to_object", "to", "entity_value"],
        relationKey: "relation_type",
      },
      {
        abs: resolveProjectZonePath(
          projectKey,
          "canonical",
          "relations",
          "code_table_links.jsonl",
        ),
        pathHint: "canonical/relations/code_table_links.jsonl",
        fromKeys: ["from_object", "code_object", "from"],
        toKeys: ["to_object", "table_name", "to"],
        relationKey: "relation_type",
      },
      {
        abs: resolveProjectZonePath(
          projectKey,
          "canonical",
          "relations",
          "class_analysis_links.jsonl",
        ),
        pathHint: "canonical/relations/class_analysis_links.jsonl",
        fromKeys: ["from_object", "from"],
        toKeys: ["to_object", "to"],
        relationKey: "relation_type",
      },
    ] as const;
  };

  for (let hop = 1; hop <= maxHops; hop++) {
    if (frontier.size === 0) break;
    const nextFrontier = new Set<string>();
    const hopEdges: RawEdge[] = [];

    for (const corp of corpora(params.projectKey)) {
      const loaded = await loadMatchingEdges({
        abs: corp.abs,
        pathHint: corp.pathHint,
        seeds: frontier,
        maxEdges: maxEdgesPerHop,
        fromKeys: [...corp.fromKeys],
        toKeys: [...corp.toKeys],
        relationKey: corp.relationKey,
        typeFromKey: "typeFromKey" in corp ? corp.typeFromKey : undefined,
        typeToKey: "typeToKey" in corp ? corp.typeToKey : undefined,
        focused: params.focused === true,
      });
      hopEdges.push(...loaded);
    }

    for (const raw of hopEdges) {
      const fromMissing = !raw.from || raw.from === "?";
      const toMissing = !raw.to || raw.to === "?";
      if (fromMissing && toMissing) continue;
      if (
        (!fromMissing && raw.from.length < 2) ||
        (!toMissing && raw.to.length < 2)
      ) {
        continue;
      }
      const fromType = raw.from_type ?? "TECHNICAL_SYMBOL";
      const toType = raw.to_type ?? "TECHNICAL_SYMBOL";
      const fromId = nodeId(fromType, fromMissing ? "?" : raw.from);
      const toId = nodeId(toType, toMissing ? "?" : raw.to);
      const unresolved = fromMissing || toMissing;

      if (!nodeMap.has(fromId)) {
        nodeMap.set(fromId, {
          id: fromId,
          type: fromType,
          name: fromMissing ? "?" : raw.from,
          source: "relation_expansion",
          source_path: raw.source_path,
          exact_match: !unresolved && (frontier.has(raw.from) || [...frontier].some((s) =>
            raw.from.toUpperCase().includes(s.toUpperCase()),
          )),
          score: unresolved ? 0.2 : 0.8,
          attributes: unresolved ? { resolution: "SOURCE_SCOPE_UNKNOWN" } : {},
        });
      }
      if (!nodeMap.has(toId)) {
        nodeMap.set(toId, {
          id: toId,
          type: toType,
          name: toMissing ? "?" : raw.to,
          source: "relation_expansion",
          source_path: raw.source_path,
          exact_match: !unresolved && (frontier.has(raw.to) || [...frontier].some((s) =>
            raw.to.toUpperCase().includes(s.toUpperCase()),
          )),
          score: unresolved ? 0.2 : 0.75,
          attributes: unresolved ? { resolution: "SOURCE_SCOPE_UNKNOWN" } : {},
        });
      }

      const edge: EvidenceGraphEdge = {
        from: fromId,
        relation: raw.relation,
        to: toId,
        resolution: unresolved ? "SOURCE_SCOPE_UNKNOWN" : "RESOLVED_STATIC",
        evidence: raw.evidence,
        confidence: unresolved ? Math.min(raw.confidence, 0.3) : raw.confidence,
        hop,
      };
      const k = edgeKey(edge);
      if (!edgeMap.has(k)) edgeMap.set(k, edge);

      if (!unresolved) {
        for (const name of [raw.from, raw.to]) {
          if (name.length >= 3 && name !== "?" && !seedsUsed.includes(name)) {
            nextFrontier.add(name);
          }
        }
      }
    }

    for (const s of frontier) seedsUsed.push(s);
    // Cap frontier growth in focused mode
    if (params.focused && nextFrontier.size > 40) {
      frontier = new Set([...nextFrontier].slice(0, 40));
    } else {
      frontier = nextFrontier;
    }
  }

  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    seeds_used: [...new Set(seedsUsed)],
    hops: maxHops,
    duration_ms: Date.now() - started,
  };
}
