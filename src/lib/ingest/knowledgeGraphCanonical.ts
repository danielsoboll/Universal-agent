/**
 * Deterministic knowledge graph from message-idoc + repository-relations canonicals.
 *
 * Identity rule: merge only when object_type matches exactly (after normalization).
 * Never merge OUTPUT_TYPE / CONDITION_TYPE / MESSAGE_TYPE / … by bare name alone.
 * Authoritative existence evidence stays separate from code-usage evidence.
 */

import { createHash } from "crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { createInterface } from "readline";
import { finished } from "stream/promises";
import type { WriteStream } from "fs";
import {
  mapLegacyRelation,
  mapMessageIdocObjectType,
} from "@/lib/knowledge/anchorRag/relationCatalog";

export const KNOWLEDGE_GRAPH_DIR = "knowledge-graph" as const;
export const KNOWLEDGE_GRAPH_OUTPUTS = [
  "nodes.jsonl",
  "edges.jsonl",
  "unresolved.jsonl",
  "manifest.json",
] as const;

export const KNOWLEDGE_GRAPH_SOURCES = [
  "message-idoc-config/objects.jsonl",
  "message-idoc-config/relations.jsonl",
  "message-idoc-config/relations.from-groups-01-10.jsonl",
  "repository-relations/objects.jsonl",
  "repository-relations/relations.jsonl",
  "repository-relations/unresolved.jsonl",
] as const;

/** Types that must never be merged across each other by name alone. */
export const TYPE_NAMESPACE_STRICT = new Set([
  "OUTPUT_TYPE",
  "OUTPUT_TYPE_TEXT",
  "OUTPUT_PROCESSING",
  "CONDITION_TYPE",
  "PRICING_CONDITION_TYPE",
  "MESSAGE_TYPE",
  "IDOC_TYPE",
  "IDOC_EXTENSION",
  "PARTNER_PROFILE",
  "PROCESS_CODE",
  "PORT",
  "LOGICAL_SYSTEM",
]);

export type EvidenceClass =
  | "authoritative_existence"
  | "authoritative_config"
  | "usage_relation"
  | "code_usage"
  | "unresolved";

type SourceRef = {
  file: string;
  source_table?: string | null;
};

type NodeAcc = {
  node_id: string;
  object_type: string;
  name: string;
  identity_key: string;
  system_id: string;
  display_names: Set<string>;
  authoritative_existence: boolean;
  code_usage: boolean;
  sources: Map<string, SourceRef>;
  attributes: Record<string, unknown>;
};

type EdgeAcc = {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  relation_type: string;
  relation_unified: string;
  occurrence_count: number;
  contexts: Set<string>;
  evidence_class: EvidenceClass;
  resolution: "RESOLVED" | "UNRESOLVED";
  authoritative: boolean;
  source_files: Set<string>;
  source_tables: Set<string>;
};

export type KnowledgeGraphStats = {
  sources_read: Record<string, number>;
  nodes_total: number;
  nodes_by_type: Record<string, number>;
  edges_resolved_raw: number;
  edges_resolved_unique: number;
  edges_dup_merged: number;
  edges_unresolved_raw: number;
  edges_unresolved_unique: number;
  edges_unresolved_dup_merged: number;
  edges_by_relation: Record<string, number>;
  type_conflicts: number;
  name_collisions_not_merged: number;
  name_collision_samples: Array<{
    name: string;
    types: string[];
  }>;
};

export type KnowledgeGraphManifest = {
  schema_version: string;
  pass: "knowledge_graph_v1";
  ok: boolean;
  built_at: string;
  sources: typeof KNOWLEDGE_GRAPH_SOURCES;
  outputs: Record<string, string>;
  stats: KnowledgeGraphStats;
  notes: string[];
};

function bump(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

function sha24(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 24);
}

async function* streamJsonl(
  abs: string,
): AsyncGenerator<Record<string, unknown>> {
  if (!existsSync(abs)) return;
  const rl = createInterface({
    input: createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as unknown;
        if (o && typeof o === "object" && !Array.isArray(o)) {
          yield o as Record<string, unknown>;
        }
      } catch {
        /* skip bad lines */
      }
    }
  } finally {
    rl.close();
  }
}

/** Normalize raw type strings into stable graph object types. */
export function normalizeObjectType(raw: string): string {
  const t = raw.trim();
  if (!t) return "UNKNOWN";
  const lower = t.toLowerCase();
  const mapped = mapMessageIdocObjectType(lower);
  if (mapped !== "UNKNOWN") return mapped;

  const u = t.toUpperCase().replace(/\s+/g, "_");
  const aliases: Record<string, string> = {
    PROGRAM: "PROGRAM",
    CLASS: "CLASS",
    FUNCTION_MODULE: "FUNCTION_MODULE",
    FUNCTION: "FUNCTION_MODULE",
    METHOD: "METHOD",
    FORM: "FORM_ROUTINE",
    FORM_ROUTINE: "FORM_ROUTINE",
    INCLUDE: "INCLUDE",
    TABLE: "TABLE",
    TABLE_SYMBOL: "TABLE_SYMBOL",
    METHOD_SYMBOL: "METHOD_SYMBOL",
    CLASS_METHOD_SYMBOL: "CLASS_METHOD_SYMBOL",
    OTHER_CLASS_INCLUDE: "CLASS_INCLUDE",
    CLASS_INCLUDE: "CLASS_INCLUDE",
    CLASS_SECTION: "CLASS_SECTION",
    CLASS_INTERFACE_SECTION: "CLASS_INTERFACE_SECTION",
    CLASS_POOL: "CLASS_POOL",
    LOCAL_DEFINITION: "LOCAL_DEFINITION",
    LOCAL_IMPLEMENTATION: "LOCAL_IMPLEMENTATION",
    LOCAL_MACROS: "LOCAL_MACROS",
    FUNCTION_GROUP_PROGRAM: "FUNCTION_GROUP",
    FUNCTION_MODULE_SYMBOL: "FUNCTION_MODULE_SYMBOL",
    TRANSACTION: "TRANSACTION",
    OUTPUT_TYPE: "OUTPUT_TYPE",
    MESSAGE_TYPE: "MESSAGE_TYPE",
    IDOC_TYPE: "IDOC_TYPE",
    IDOC_EXTENSION: "IDOC_EXTENSION",
    PARTNER_PROFILE: "PARTNER_PROFILE",
    EXTERNAL_TECHNICAL: "TECHNICAL_SYMBOL",
    TECHNICAL_SYMBOL: "TECHNICAL_SYMBOL",
  };
  return aliases[u] ?? u;
}

/**
 * Build identity key within a type namespace.
 * OUTPUT_TYPE keeps full technical id (incl. KVEWE when present).
 */
export function identityKeyFor(
  objectType: string,
  rawName: string,
): { identity_key: string; name: string; display_name: string } {
  const display = rawName.trim();
  const ot = objectType.toUpperCase();

  if (ot === "OUTPUT_TYPE" || ot === "OUTPUT_TYPE_TEXT") {
    // Prefer KVEWE|KAPPL|KSCHL when present; else KAPPL|KSCHL
    const parts = display.split("|").map((p) => p.trim()).filter(Boolean);
    let identity = display;
    let shortName = display;
    if (parts.length >= 3) {
      identity = parts.join("|");
      shortName = parts[parts.length - 1]!;
    } else if (parts.length === 2) {
      identity = parts.join("|");
      shortName = parts[1]!;
    }
    return { identity_key: identity, name: shortName, display_name: display };
  }

  if (ot === "METHOD") {
    // CLASS|METHOD → keep full; short name = method
    const parts = display.split("|");
    const short = parts.length > 1 ? parts[parts.length - 1]! : display;
    return {
      identity_key: display.replace(/\|$/, ""),
      name: short || display,
      display_name: display,
    };
  }

  if (ot === "PROGRAM" || ot === "FUNCTION_MODULE" || ot === "CLASS") {
    // Repo sometimes uses "PROG|PROG" — collapse identical duplicates
    const parts = display.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2 && parts[0]!.toUpperCase() === parts[1]!.toUpperCase()) {
      return {
        identity_key: parts[0]!,
        name: parts[0]!,
        display_name: display,
      };
    }
    const base = parts[0] || display;
    return { identity_key: base, name: base, display_name: display };
  }

  return { identity_key: display, name: display, display_name: display };
}

export function makeNodeId(
  systemId: string,
  objectType: string,
  identityKey: string,
): string {
  return `${objectType}|${systemId}|${identityKey}`;
}

/**
 * Same-type OUTPUT_TYPE merge: V1|ZECD aliases into B|V1|ZECD when both exist.
 * Never crosses into CONDITION_TYPE / MESSAGE_TYPE.
 */
function outputTypeAliasKeys(identityKey: string): string[] {
  const parts = identityKey.split("|").map((p) => p.trim()).filter(Boolean);
  const keys = [identityKey];
  if (parts.length >= 3 && parts[0]!.length === 1) {
    // KVEWE|KAPPL|KSCHL → also KAPPL|KSCHL
    keys.push(parts.slice(1).join("|"));
  }
  return [...new Set(keys)];
}

type BuildCtx = {
  nodes: Map<string, NodeAcc>;
  /** type|nameUpper → node_ids (for collision report) */
  nameIndex: Map<string, Set<string>>;
  edges: Map<string, EdgeAcc>;
  unresolved: Map<string, EdgeAcc>;
  stats: KnowledgeGraphStats;
  /** OUTPUT_TYPE alias → preferred node_id */
  outputTypeAliases: Map<string, string>;
};

function emptyStats(): KnowledgeGraphStats {
  return {
    sources_read: {},
    nodes_total: 0,
    nodes_by_type: {},
    edges_resolved_raw: 0,
    edges_resolved_unique: 0,
    edges_dup_merged: 0,
    edges_unresolved_raw: 0,
    edges_unresolved_unique: 0,
    edges_unresolved_dup_merged: 0,
    edges_by_relation: {},
    type_conflicts: 0,
    name_collisions_not_merged: 0,
    name_collision_samples: [],
  };
}

function ensureNode(
  ctx: BuildCtx,
  params: {
    system_id: string;
    object_type_raw: string;
    name_raw: string;
    source_file: string;
    source_table?: string | null;
    authoritative_existence?: boolean;
    code_usage?: boolean;
    attributes?: Record<string, unknown>;
  },
): string {
  const object_type = normalizeObjectType(params.object_type_raw);
  const { identity_key, name, display_name } = identityKeyFor(
    object_type,
    params.name_raw,
  );
  const system_id = params.system_id || "Q01";

  // OUTPUT_TYPE: resolve alias to existing authoritative id if present
  let node_id = makeNodeId(system_id, object_type, identity_key);
  if (object_type === "OUTPUT_TYPE") {
    for (const alias of outputTypeAliasKeys(identity_key)) {
      const mapped = ctx.outputTypeAliases.get(`${system_id}|${alias}`);
      if (mapped) {
        node_id = mapped;
        break;
      }
    }
  }

  let node = ctx.nodes.get(node_id);
  if (!node) {
    // Try merge OUTPUT_TYPE KAPPL|KSCHL into existing B|KAPPL|KSCHL
    if (object_type === "OUTPUT_TYPE") {
      const parts = identity_key.split("|");
      if (parts.length === 2) {
        const authId = makeNodeId(system_id, object_type, `B|${identity_key}`);
        if (ctx.nodes.has(authId)) {
          node_id = authId;
          node = ctx.nodes.get(authId);
        }
      }
    }
  }

  if (!node) {
    node = {
      node_id,
      object_type,
      name,
      identity_key:
        object_type === "OUTPUT_TYPE" && node_id.includes("|B|")
          ? node_id.split("|").slice(2).join("|")
          : identity_key,
      system_id,
      display_names: new Set([display_name]),
      authoritative_existence: Boolean(params.authoritative_existence),
      code_usage: Boolean(params.code_usage),
      sources: new Map(),
      attributes: { ...(params.attributes ?? {}) },
    };
    ctx.nodes.set(node_id, node);
    for (const alias of outputTypeAliasKeys(node.identity_key)) {
      ctx.outputTypeAliases.set(`${system_id}|${alias}`, node_id);
    }
  } else {
    node.display_names.add(display_name);
    if (params.authoritative_existence) node.authoritative_existence = true;
    if (params.code_usage) node.code_usage = true;
    Object.assign(node.attributes, params.attributes ?? {});
  }

  const srcKey = `${params.source_file}|${params.source_table ?? ""}`;
  node.sources.set(srcKey, {
    file: params.source_file,
    source_table: params.source_table ?? null,
  });

  // Name index for collision reporting (same name, different types → not merged)
  const nu = name.toUpperCase();
  if (nu.length >= 2) {
    let set = ctx.nameIndex.get(nu);
    if (!set) {
      set = new Set();
      ctx.nameIndex.set(nu, set);
    }
    set.add(node_id);
  }

  return node_id;
}

function addEdge(
  ctx: BuildCtx,
  params: {
    from_node_id: string;
    to_node_id: string;
    relation_type: string;
    occurrence_count: number;
    contexts: string[];
    evidence_class: EvidenceClass;
    resolution: "RESOLVED" | "UNRESOLVED";
    authoritative: boolean;
    source_file: string;
    source_tables: string[];
  },
): void {
  const unified = mapLegacyRelation(params.relation_type);
  const edge_id = sha24(
    [
      params.from_node_id,
      params.relation_type,
      params.to_node_id,
      params.evidence_class,
      params.resolution,
    ].join("\u0001"),
  );
  const target =
    params.resolution === "UNRESOLVED" ? ctx.unresolved : ctx.edges;

  if (params.resolution === "UNRESOLVED") {
    ctx.stats.edges_unresolved_raw += params.occurrence_count;
  } else {
    ctx.stats.edges_resolved_raw += params.occurrence_count;
  }
  bump(ctx.stats.edges_by_relation, params.relation_type, params.occurrence_count);

  const existing = target.get(edge_id);
  if (existing) {
    existing.occurrence_count += params.occurrence_count;
    for (const c of params.contexts) if (c) existing.contexts.add(c);
    existing.source_files.add(params.source_file);
    for (const t of params.source_tables) if (t) existing.source_tables.add(t);
    if (params.authoritative) existing.authoritative = true;
    if (params.resolution === "UNRESOLVED") {
      ctx.stats.edges_unresolved_dup_merged += 1;
    } else {
      ctx.stats.edges_dup_merged += 1;
    }
    return;
  }

  target.set(edge_id, {
    edge_id,
    from_node_id: params.from_node_id,
    to_node_id: params.to_node_id,
    relation_type: params.relation_type,
    relation_unified: unified,
    occurrence_count: params.occurrence_count,
    contexts: new Set(params.contexts.filter(Boolean)),
    evidence_class: params.evidence_class,
    resolution: params.resolution,
    authoritative: params.authoritative,
    source_files: new Set([params.source_file]),
    source_tables: new Set(params.source_tables.filter(Boolean)),
  });
}

function contextsFromUnknown(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "string") return raw ? [raw] : [];
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.raw_metadata)) {
      return o.raw_metadata.map(String);
    }
    return [JSON.stringify(raw)];
  }
  return [];
}

export type BuildKnowledgeGraphParams = {
  absoluteCanonicalRoot: string;
  overwrite?: boolean;
};

export type BuildKnowledgeGraphResult = {
  ok: boolean;
  errors: string[];
  manifest: KnowledgeGraphManifest;
  absoluteDir: string;
};

export async function buildKnowledgeGraph(
  params: BuildKnowledgeGraphParams,
): Promise<BuildKnowledgeGraphResult> {
  const errors: string[] = [];
  const root = params.absoluteCanonicalRoot;
  const outDir = path.join(root, KNOWLEDGE_GRAPH_DIR);
  mkdirSync(outDir, { recursive: true });

  const finalPaths = Object.fromEntries(
    KNOWLEDGE_GRAPH_OUTPUTS.map((n) => [n, path.join(outDir, n)]),
  ) as Record<(typeof KNOWLEDGE_GRAPH_OUTPUTS)[number], string>;

  if (!params.overwrite && existsSync(finalPaths["manifest.json"])) {
    return {
      ok: false,
      errors: [
        "Write-once verweigert — knowledge-graph/manifest.json existiert bereits",
      ],
      absoluteDir: outDir,
      manifest: stubManifest(emptyStats(), false),
    };
  }

  // Snapshot sibling domains — must not change
  const protectedRels = [
    "message-idoc-config/relations.jsonl",
    "message-idoc-config/relations.from-groups-01-10.jsonl",
    "message-idoc-config/objects.jsonl",
    "message-idoc-config/relations-manifest.json",
    "repository-relations/objects.jsonl",
    "repository-relations/relations.jsonl",
    "repository-relations/unresolved.jsonl",
    "repository-relations/manifest.json",
  ];
  const protectedSnap = protectedRels.map((rel) => {
    const abs = path.join(root, rel);
    return {
      rel,
      abs,
      mtime: existsSync(abs) ? statSync(abs).mtimeMs : null,
      size: existsSync(abs) ? statSync(abs).size : null,
    };
  });

  const ctx: BuildCtx = {
    nodes: new Map(),
    nameIndex: new Map(),
    edges: new Map(),
    unresolved: new Map(),
    stats: emptyStats(),
    outputTypeAliases: new Map(),
  };

  // --- 0) message-idoc canonical objects + texts (authoritative existence) ---
  {
    const file = "message-idoc-config/objects.jsonl";
    const abs = path.join(root, file);
    let n = 0;
    for await (const o of streamJsonl(abs)) {
      n += 1;
      const object_type_raw = String(o.object_type ?? "");
      const object_id = String(o.object_id ?? "");
      const display_name =
        typeof o.display_name === "string" ? o.display_name : "";
      const attrs = (o.attributes as Record<string, unknown>) ?? {};
      const source = (o.source as Record<string, unknown>) ?? {};
      const source_table =
        typeof source.source_table === "string" ? source.source_table : null;
      const system_id =
        typeof source.system_id === "string"
          ? source.system_id
          : String(o.system_id ?? "Q01");

      const ot = normalizeObjectType(object_type_raw);
      const isOutputFamily =
        ot === "OUTPUT_TYPE" || ot === "OUTPUT_TYPE_TEXT";
      // Existence only for real config objects (T685 already KVEWE-filtered in convert)
      const authoritative_existence =
        ot === "OUTPUT_TYPE" ||
        ot === "OUTPUT_TYPE_TEXT" ||
        ot === "MESSAGE_TYPE" ||
        ot === "IDOC_TYPE" ||
        ot === "IDOC_EXTENSION" ||
        ot === "IDOC_SEGMENT" ||
        ot === "PARTNER_PROFILE" ||
        ot === "PROCESS_CODE" ||
        ot === "PORT" ||
        ot === "LOGICAL_SYSTEM";

      const nodeId = ensureNode(ctx, {
        system_id,
        object_type_raw,
        name_raw: object_id,
        source_file: file,
        source_table,
        authoritative_existence,
        attributes: {
          display_name: display_name || null,
          ...attrs,
          canonical_object_type: object_type_raw,
        },
      });

      // Text / description on node
      if (display_name) {
        const node = ctx.nodes.get(nodeId);
        if (node) {
          node.attributes.display_name = display_name;
          if (typeof attrs.VTEXT === "string") {
            node.attributes.VTEXT = attrs.VTEXT;
          }
        }
      }

      // OUTPUT_TYPE_TEXT → parent OUTPUT_TYPE edge (HAS_TEXT)
      if (ot === "OUTPUT_TYPE_TEXT") {
        const parent =
          typeof attrs.parent_output_type_id === "string"
            ? attrs.parent_output_type_id
            : object_id.split("|").slice(0, 3).join("|");
        if (parent) {
          const parentId = ensureNode(ctx, {
            system_id,
            object_type_raw: "output_type",
            name_raw: parent,
            source_file: file,
            source_table,
            authoritative_existence: true,
          });
          addEdge(ctx, {
            from_node_id: parentId,
            to_node_id: nodeId,
            relation_type: "OUTPUT_TYPE_HAS_TEXT",
            occurrence_count: 1,
            contexts: [
              display_name || String(attrs.VTEXT ?? ""),
              source_table ?? "",
            ].filter(Boolean),
            evidence_class: "authoritative_existence",
            resolution: "RESOLVED",
            authoritative: true,
            source_file: file,
            source_tables: source_table ? [source_table] : [],
          });
        }
      }

      // MESSAGE_TYPE / IDOC texts similarly
      if (
        object_type_raw === "ale_message_type_text" ||
        object_type_raw === "idoc_type_text"
      ) {
        const parentKey =
          typeof attrs.parent_message_type_id === "string"
            ? attrs.parent_message_type_id
            : typeof attrs.parent_idoc_type_id === "string"
              ? attrs.parent_idoc_type_id
              : null;
        const parentType =
          object_type_raw === "ale_message_type_text"
            ? "ale_message_type"
            : "idoc_type";
        if (parentKey) {
          const parentId = ensureNode(ctx, {
            system_id,
            object_type_raw: parentType,
            name_raw: parentKey,
            source_file: file,
            source_table,
            authoritative_existence: true,
          });
          addEdge(ctx, {
            from_node_id: parentId,
            to_node_id: nodeId,
            relation_type:
              object_type_raw === "ale_message_type_text"
                ? "MESSAGE_TYPE_HAS_TEXT"
                : "IDOC_TYPE_HAS_TEXT",
            occurrence_count: 1,
            contexts: [display_name || String(attrs.VTEXT ?? "")].filter(
              Boolean,
            ),
            evidence_class: "authoritative_existence",
            resolution: "RESOLVED",
            authoritative: true,
            source_file: file,
            source_tables: source_table ? [source_table] : [],
          });
        }
      }

      void isOutputFamily;
    }
    ctx.stats.sources_read[file] = n;
  }

  // --- 1) repository objects ---
  {
    const file = "repository-relations/objects.jsonl";
    const abs = path.join(root, file);
    let n = 0;
    for await (const o of streamJsonl(abs)) {
      n += 1;
      ensureNode(ctx, {
        system_id: String(o.system_id ?? "Q01"),
        object_type_raw: String(o.object_type ?? ""),
        name_raw: String(o.object_name ?? o.source_key ?? ""),
        source_file: file,
        code_usage: true,
        attributes: {
          description: o.description ?? "",
          source_key: o.source_key ?? null,
          active: o.active ?? null,
        },
      });
    }
    ctx.stats.sources_read[file] = n;
  }

  // --- 2) message-idoc 11 relations ---
  {
    const file = "message-idoc-config/relations.jsonl";
    const abs = path.join(root, file);
    let n = 0;
    for await (const o of streamJsonl(abs)) {
      n += 1;
      const system_id = String(o.system_id ?? "Q01");
      const from_type = String(o.from_type ?? "");
      const to_type = String(o.to_type ?? "");
      const from_name = String(o.from_name ?? "");
      const to_name = String(o.to_name ?? "");
      const relation_type = String(o.relation_type ?? "");
      const occ = Number(o.occurrence_count ?? 1) || 1;
      const source_tables = Array.isArray(o.source_tables)
        ? o.source_tables.map(String)
        : o.primary_source_table
          ? [String(o.primary_source_table)]
          : [];
      const authoritative = Boolean(o.authoritative);
      const usage = Boolean(o.usage_relation);
      const evidence_class: EvidenceClass = authoritative
        ? "authoritative_config"
        : usage
          ? "usage_relation"
          : "authoritative_config";

      const fromId = ensureNode(ctx, {
        system_id,
        object_type_raw: from_type,
        name_raw: from_name,
        source_file: file,
        source_table: source_tables[0] ?? null,
        // MESSAGE_TYPE + authoritative USES_IDOC = config existence for message/idoc mapping
        authoritative_existence:
          authoritative &&
          (normalizeObjectType(from_type) === "MESSAGE_TYPE" ||
            normalizeObjectType(from_type) === "IDOC_TYPE"),
        code_usage: usage,
      });
      const toId = ensureNode(ctx, {
        system_id,
        object_type_raw: to_type,
        name_raw: to_name,
        source_file: file,
        source_table: source_tables[0] ?? null,
        authoritative_existence: authoritative,
        code_usage: usage,
      });

      addEdge(ctx, {
        from_node_id: fromId,
        to_node_id: toId,
        relation_type,
        occurrence_count: occ,
        contexts: contextsFromUnknown(o.contexts),
        evidence_class,
        resolution: "RESOLVED",
        authoritative,
        source_file: file,
        source_tables,
      });
    }
    ctx.stats.sources_read[file] = n;
  }

  // --- 3) message-idoc groups 01-10 derived relations ---
  {
    const file = "message-idoc-config/relations.from-groups-01-10.jsonl";
    const abs = path.join(root, file);
    let n = 0;
    for await (const o of streamJsonl(abs)) {
      n += 1;
      const from_ot = String(o.from_object_type ?? "");
      const to_ot = String(o.to_object_type ?? "");
      const from_id = String(o.from_object_id ?? "");
      const to_id = String(o.to_object_id ?? "");
      const relation_kind = String(o.relation_kind ?? "");
      const source = (o.source as Record<string, unknown>) ?? {};
      const source_table =
        typeof source.source_table === "string" ? source.source_table : null;
      const source_file_raw =
        typeof source.raw_file === "string"
          ? `raw/message-idoc-config/${source.raw_file}`
          : file;
      const fromTypeNorm = normalizeObjectType(from_ot);
      // Derived output_type edges come from KVEWE=B filtered convert → existence
      const authExistence = fromTypeNorm === "OUTPUT_TYPE";

      let toTypeRaw = to_ot;
      if (to_ot === "external_technical") {
        if (
          relation_kind === "OUTPUT_TYPE_TO_ROUTINE" ||
          relation_kind === "OUTPUT_TYPE_TO_FORM"
        ) {
          toTypeRaw = "FORM_ROUTINE";
        } else if (
          relation_kind === "OUTPUT_TYPE_TO_PROGRAM" ||
          relation_kind === "TECHNICAL_OBJECT_TO_PROGRAM"
        ) {
          toTypeRaw = "PROGRAM";
        } else if (relation_kind === "TECHNICAL_OBJECT_TO_FUNCTION_MODULE") {
          toTypeRaw = "FUNCTION_MODULE";
        } else {
          toTypeRaw = "TECHNICAL_SYMBOL";
        }
      }

      const fromNode = ensureNode(ctx, {
        system_id: "Q01",
        object_type_raw: from_ot,
        name_raw: from_id,
        source_file: file,
        source_table,
        authoritative_existence: authExistence,
        attributes: {
          from_groups_object_type: from_ot,
          provenance_raw_file: source_file_raw,
        },
      });
      const toNode = ensureNode(ctx, {
        system_id: "Q01",
        object_type_raw: toTypeRaw,
        name_raw: to_id,
        source_file: file,
        source_table,
        code_usage: true,
        attributes: {
          from_groups_object_type: to_ot,
          provenance_raw_file: source_file_raw,
        },
      });

      addEdge(ctx, {
        from_node_id: fromNode,
        to_node_id: toNode,
        relation_type: relation_kind,
        occurrence_count: 1,
        contexts: [
          JSON.stringify(o.attributes ?? {}),
          source_file_raw,
        ].filter(Boolean),
        evidence_class: authExistence
          ? "authoritative_existence"
          : "authoritative_config",
        resolution: "RESOLVED",
        authoritative: authExistence,
        source_file: file,
        source_tables: source_table ? [source_table] : [],
      });
    }
    ctx.stats.sources_read[file] = n;
  }

  // --- 4) repository relations (resolved) ---
  {
    const file = "repository-relations/relations.jsonl";
    const abs = path.join(root, file);
    let n = 0;
    for await (const o of streamJsonl(abs)) {
      n += 1;
      const system_id = String(o.system_id ?? "Q01");
      const fromId = ensureNode(ctx, {
        system_id,
        object_type_raw: String(o.from_type ?? ""),
        name_raw: String(o.from_name ?? ""),
        source_file: file,
        code_usage: true,
      });
      const toId = ensureNode(ctx, {
        system_id,
        object_type_raw: String(o.to_type ?? ""),
        name_raw: String(o.to_name ?? ""),
        source_file: file,
        code_usage: true,
      });
      addEdge(ctx, {
        from_node_id: fromId,
        to_node_id: toId,
        relation_type: String(o.relation_type ?? ""),
        occurrence_count: Number(o.occurrence_count ?? 1) || 1,
        contexts: contextsFromUnknown(o.contexts),
        evidence_class: "code_usage",
        resolution: "RESOLVED",
        authoritative: false,
        source_file: file,
        source_tables: [],
      });
    }
    ctx.stats.sources_read[file] = n;
  }

  // --- 5) repository unresolved ---
  {
    const file = "repository-relations/unresolved.jsonl";
    const abs = path.join(root, file);
    let n = 0;
    for await (const o of streamJsonl(abs)) {
      n += 1;
      const system_id = String(o.system_id ?? "Q01");
      const fromId = ensureNode(ctx, {
        system_id,
        object_type_raw: String(o.from_type ?? ""),
        name_raw: String(o.from_name ?? ""),
        source_file: file,
        code_usage: true,
      });
      const toId = ensureNode(ctx, {
        system_id,
        object_type_raw: String(o.to_type ?? ""),
        name_raw: String(o.to_name ?? ""),
        source_file: file,
        code_usage: true,
      });
      addEdge(ctx, {
        from_node_id: fromId,
        to_node_id: toId,
        relation_type: String(o.relation_type ?? ""),
        occurrence_count: Number(o.occurrence_count ?? 1) || 1,
        contexts: contextsFromUnknown(o.contexts),
        evidence_class: "unresolved",
        resolution: "UNRESOLVED",
        authoritative: false,
        source_file: file,
        source_tables: [],
      });
    }
    ctx.stats.sources_read[file] = n;
  }

  // Finalize collision stats
  for (const [name, ids] of ctx.nameIndex) {
    const types = new Set(
      [...ids].map((id) => ctx.nodes.get(id)?.object_type ?? "UNKNOWN"),
    );
    if (types.size > 1) {
      // Check if any pair are both in TYPE_NAMESPACE_STRICT — intentional non-merge
      const typeList = [...types];
      const strictHit = typeList.filter((t) => TYPE_NAMESPACE_STRICT.has(t));
      if (strictHit.length >= 1 && typeList.length >= 2) {
        ctx.stats.name_collisions_not_merged += 1;
        if (ctx.stats.name_collision_samples.length < 40) {
          ctx.stats.name_collision_samples.push({
            name,
            types: typeList.sort(),
          });
        }
      } else if (typeList.length >= 2) {
        ctx.stats.type_conflicts += 1;
        if (ctx.stats.name_collision_samples.length < 40) {
          ctx.stats.name_collision_samples.push({
            name,
            types: typeList.sort(),
          });
        }
      }
    }
  }

  ctx.stats.nodes_total = ctx.nodes.size;
  for (const n of ctx.nodes.values()) {
    bump(ctx.stats.nodes_by_type, n.object_type);
  }
  ctx.stats.edges_resolved_unique = ctx.edges.size;
  ctx.stats.edges_unresolved_unique = ctx.unresolved.size;

  const staging = path.join(
    outDir,
    `.tmp-kg-${process.pid}-${Date.now()}`,
  );
  mkdirSync(staging, { recursive: true });

  try {
    const nodesPath = path.join(staging, "nodes.jsonl");
    const edgesPath = path.join(staging, "edges.jsonl");
    const unresolvedPath = path.join(staging, "unresolved.jsonl");
    const manifestPath = path.join(staging, "manifest.json");

    await writeNodes(nodesPath, ctx.nodes);
    await writeEdges(edgesPath, ctx.edges);
    await writeEdges(unresolvedPath, ctx.unresolved);

    const manifest: KnowledgeGraphManifest = {
      schema_version: "1.0",
      pass: "knowledge_graph_v1",
      ok: true,
      built_at: new Date().toISOString(),
      sources: KNOWLEDGE_GRAPH_SOURCES,
      outputs: {
        nodes: `canonical/${KNOWLEDGE_GRAPH_DIR}/nodes.jsonl`,
        edges: `canonical/${KNOWLEDGE_GRAPH_DIR}/edges.jsonl`,
        unresolved: `canonical/${KNOWLEDGE_GRAPH_DIR}/unresolved.jsonl`,
        manifest: `canonical/${KNOWLEDGE_GRAPH_DIR}/manifest.json`,
      },
      stats: ctx.stats,
      notes: [
        "Deterministic merge: same object_type + identity_key only",
        "OUTPUT_TYPE/CONDITION_TYPE/MESSAGE_TYPE never merged by bare name",
        "Authoritative existence vs code usage kept as separate evidence flags",
        "Unresolved edges preserved in unresolved.jsonl",
        "No OpenAI / embeddings / index rebuild",
        "Source canonical files not modified",
      ],
    };

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    for (const name of KNOWLEDGE_GRAPH_OUTPUTS) {
      const from = path.join(staging, name);
      const to = finalPaths[name];
      if (params.overwrite && existsSync(to)) rmSync(to, { force: true });
      renameSync(from, to);
    }

    for (const p of protectedSnap) {
      const mtime = existsSync(p.abs) ? statSync(p.abs).mtimeMs : null;
      const size = existsSync(p.abs) ? statSync(p.abs).size : null;
      if (p.mtime !== mtime || p.size !== size) {
        errors.push(`PROTECTED TOUCHED: ${p.rel}`);
      }
    }

    if (errors.length) {
      manifest.ok = false;
      writeFileSync(
        finalPaths["manifest.json"],
        `${JSON.stringify({ ...manifest, ok: false, errors }, null, 2)}\n`,
        "utf8",
      );
    }

    return { ok: errors.length === 0, errors, manifest, absoluteDir: outDir };
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      errors,
      absoluteDir: outDir,
      manifest: stubManifest(ctx.stats, false),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function writeNodes(
  abs: string,
  nodes: Map<string, NodeAcc>,
): Promise<void> {
  const rows = [...nodes.values()].sort((a, b) =>
    a.node_id.localeCompare(b.node_id, "en"),
  );
  const ws: WriteStream = createWriteStream(abs, { flags: "w" });
  for (const n of rows) {
    const out = {
      schema_version: "1.0",
      record_type: "node",
      node_id: n.node_id,
      object_type: n.object_type,
      name: n.name,
      identity_key: n.identity_key,
      system_id: n.system_id,
      display_names: [...n.display_names].sort((a, b) => a.localeCompare(b, "en")),
      evidence: {
        authoritative_existence: n.authoritative_existence,
        code_usage: n.code_usage,
      },
      sources: [...n.sources.values()].sort((a, b) =>
        a.file.localeCompare(b.file, "en"),
      ),
      attributes: n.attributes,
    };
    if (!ws.write(`${JSON.stringify(out)}\n`)) {
      await new Promise<void>((r) => ws.once("drain", r));
    }
  }
  ws.end();
  await finished(ws);
}

async function writeEdges(
  abs: string,
  edges: Map<string, EdgeAcc>,
): Promise<void> {
  const rows = [...edges.values()].sort((a, b) =>
    a.edge_id.localeCompare(b.edge_id, "en"),
  );
  const ws: WriteStream = createWriteStream(abs, { flags: "w" });
  for (const e of rows) {
    const out = {
      schema_version: "1.0",
      record_type: "edge",
      edge_id: e.edge_id,
      from_node_id: e.from_node_id,
      to_node_id: e.to_node_id,
      relation_type: e.relation_type,
      relation_unified: e.relation_unified,
      occurrence_count: e.occurrence_count,
      contexts: [...e.contexts].sort((a, b) => a.localeCompare(b, "en")),
      evidence_class: e.evidence_class,
      resolution: e.resolution,
      authoritative: e.authoritative,
      source_files: [...e.source_files].sort((a, b) => a.localeCompare(b, "en")),
      source_tables: [...e.source_tables].sort((a, b) =>
        a.localeCompare(b, "en"),
      ),
    };
    if (!ws.write(`${JSON.stringify(out)}\n`)) {
      await new Promise<void>((r) => ws.once("drain", r));
    }
  }
  ws.end();
  await finished(ws);
}

function stubManifest(
  stats: KnowledgeGraphStats,
  ok: boolean,
): KnowledgeGraphManifest {
  return {
    schema_version: "1.0",
    pass: "knowledge_graph_v1",
    ok,
    built_at: new Date().toISOString(),
    sources: KNOWLEDGE_GRAPH_SOURCES,
    outputs: {
      nodes: `canonical/${KNOWLEDGE_GRAPH_DIR}/nodes.jsonl`,
      edges: `canonical/${KNOWLEDGE_GRAPH_DIR}/edges.jsonl`,
      unresolved: `canonical/${KNOWLEDGE_GRAPH_DIR}/unresolved.jsonl`,
      manifest: `canonical/${KNOWLEDGE_GRAPH_DIR}/manifest.json`,
    },
    stats,
    notes: ["stub"],
  };
}
