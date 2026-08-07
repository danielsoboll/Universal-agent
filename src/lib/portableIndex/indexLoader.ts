/**
 * Runtime loader for portable indexes — process-level cache, fingerprint invalidation.
 * Lazy: graph/vector only when requested; embeddings never via this loader.
 */
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import type { LexicalDocument } from "@/lib/search/lexical/types";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import {
  askPerfBegin,
  askPerfEnd,
  askPerfNote,
  askPerfSetLexicalCacheHit,
  askPerfTrackedReadFile,
} from "@/lib/knowledge/askPerf";
import {
  portableManifestPath,
  portableSubdir,
} from "@/lib/portableIndex/paths";
import type {
  PortableCodeUsagePosting,
  PortableEvidenceDocument,
  PortableGraphEdge,
  PortableGraphNode,
  PortableIndexManifest,
  PortableLexicalDocument,
  PortableSymbolNamePosting,
  PortableSymbolRecord,
} from "@/lib/portableIndex/types";
import type {
  PortableLiteralCandidateRole,
  PortableLiteralFieldPosting,
  PortableLiteralRecord,
  PortableLiteralValuePosting,
} from "@/lib/portableIndex/literalTypes";

export type PortableIndexHandle = {
  projectId: string;
  manifest: PortableIndexManifest;
  dataRoot: string;
};

type CacheEntry = {
  fingerprint: string;
  handle: PortableIndexHandle;
  lexicalDocs: LexicalDocument[] | null;
  evidenceById: Map<string, SearchDocument> | null;
  evidenceBySourceKey: Map<string, SearchDocument> | null;
  /** document_id → byte offset in evidence-store/documents.jsonl */
  evidenceOffsets: Map<string, number> | null;
  symbolsByName: Map<string, string[]> | null;
  symbolsById: Map<string, PortableSymbolRecord> | null;
  codeUsageByToken: Map<string, PortableCodeUsagePosting["hits"]> | null;
  graphNodes: PortableGraphNode[] | null;
  graphEdges: PortableGraphEdge[] | null;
  graphNodesByName: Map<string, PortableGraphNode[]> | null;
  adjacency: Map<
    string,
    Array<{
      to_node_id: string;
      relation_type: string;
      occurrence_count: number;
      evidence_class: string;
    }>
  > | null;
  literalsById: Map<string, PortableLiteralRecord> | null;
  literalsByNormalized: Map<string, string[]> | null;
  literalsByField: Map<string, string[]> | null;
  /** True once by_normalized (+ optional by_field) loaded — not full literals.jsonl */
  literalsValueIndexReady: boolean;
};

const cache = new Map<string, CacheEntry>();

function readJsonFile<T>(abs: string): T | null {
  if (!existsSync(abs)) return null;
  try {
    const { parsed } = askPerfTrackedReadFile(abs, path.basename(abs), {
      parse: (raw) => JSON.parse(raw) as T,
    });
    return (parsed as T) ?? null;
  } catch {
    return null;
  }
}

function readJsonlTracked<T>(abs: string, kind: string): T[] {
  if (!existsSync(abs)) return [];
  const { parsed } = askPerfTrackedReadFile(abs, kind, {
    parse: (raw) => {
      const out: T[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          // skip
        }
      }
      return out;
    },
  });
  return (parsed as T[]) ?? [];
}

export function clearPortableIndexCache(): void {
  cache.clear();
}

export function loadPortableManifest(
  projectId: string,
  dataRoot?: string,
): PortableIndexManifest | null {
  const root = dataRoot ?? getLocalDataRoot();
  const mp = portableManifestPath(projectId, root);
  if (!existsSync(mp)) return null;
  try {
    return JSON.parse(readFileSync(mp, "utf8")) as PortableIndexManifest;
  } catch {
    return null;
  }
}

/** True when portable index exists and looks complete enough for ask. */
export function isPortableIndexReady(
  projectId: string,
  dataRoot?: string,
): boolean {
  const m = loadPortableManifest(projectId, dataRoot);
  if (!m) return false;
  const root = dataRoot ?? getLocalDataRoot();
  const lex = path.join(
    portableSubdir(projectId, "lexical-index", root),
    "documents.jsonl",
  );
  const ev = path.join(
    portableSubdir(projectId, "evidence-store", root),
    "documents.jsonl",
  );
  return existsSync(lex) && existsSync(ev) && m.counts.lexical_documents > 0;
}

function getOrCreateEntry(
  projectId: string,
  dataRoot?: string,
): CacheEntry | null {
  const root = dataRoot ?? getLocalDataRoot();
  const key = `${projectId}::${root}`;
  const manifest = loadPortableManifest(projectId, root);
  if (!manifest) return null;

  const existing = cache.get(key);
  if (existing && existing.fingerprint === manifest.sources_fingerprint) {
    askPerfNote(
      `portableIndex cache HIT (${projectId}, fp=${manifest.sources_fingerprint.slice(0, 12)}…)`,
    );
    return existing;
  }

  askPerfNote(
    existing
      ? "portableIndex cache MISS (fingerprint changed)"
      : "portableIndex cache MISS (cold)",
  );
  const entry: CacheEntry = {
    fingerprint: manifest.sources_fingerprint,
    handle: { projectId, manifest, dataRoot: root },
    lexicalDocs: null,
    evidenceById: null,
    evidenceBySourceKey: null,
    evidenceOffsets: null,
    symbolsByName: null,
    symbolsById: null,
    codeUsageByToken: null,
    graphNodes: null,
    graphEdges: null,
    graphNodesByName: null,
    adjacency: null,
    literalsById: null,
    literalsByNormalized: null,
    literalsByField: null,
    literalsValueIndexReady: false,
  };
  cache.set(key, entry);
  return entry;
}

function toLexicalDocument(d: PortableLexicalDocument): LexicalDocument {
  return {
    id: d.id,
    kind: d.kind as LexicalDocument["kind"],
    technical_name: d.technical_name,
    title: d.title,
    search_text: d.search_text,
    table_name: d.table_name,
    field_name: d.field_name,
    field_text: d.field_text,
    table_text: d.table_text,
    data_element: d.data_element,
    data_element_text: d.data_element_text,
    domain: d.domain,
    domain_text: d.domain_text,
    append_include: d.append_include,
    source_path: d.source_path,
    code_summary: d.code_summary,
  };
}

function evidenceToSearchDocument(e: PortableEvidenceDocument): SearchDocument {
  return {
    search_document_id: e.document_id,
    source_system: e.source_system || e.system_id || e.project_id,
    source_type: e.source_type || e.knowledge_unit_type || "unknown",
    source_key: e.source_key,
    knowledge_unit_type: e.knowledge_unit_type,
    object_type: e.object_type,
    object_name: e.object_name,
    subobject_name: e.subobject_name,
    title: e.title,
    technical_summary: e.technical_summary,
    business_purpose: e.business_purpose,
    facts: e.facts,
    inferences: e.inferences,
    entities: e.entities,
    relations: e.relations,
    tables_read: e.tables_read,
    tables_written: e.tables_written,
    called_methods: e.called_methods,
    called_functions: e.called_functions,
    macro_calls: [],
    hardcoded_values: e.hardcoded_values,
    external_interfaces: [],
    risks: [],
    evidence: e.evidence.map((x) => ({
      statement_type:
        x.statement_type === "fact" ||
        x.statement_type === "inference" ||
        x.statement_type === "general"
          ? x.statement_type
          : "general",
      text: x.text,
      lines: x.lines ?? [],
    })),
    confidence: e.confidence,
    content_hash: e.content_hash,
    analysis_version: e.analysis_version || "",
    search_text: e.search_text,
    metadata: {
      ...e.metadata,
      ...(e.source_path ? { source_path: e.source_path } : {}),
      portable_evidence: true,
    },
    created_at: e.created_at || new Date(0).toISOString(),
    updated_at: e.updated_at || new Date(0).toISOString(),
  };
}

/** Lexical corpus from portable lexical-index (no canonical scan). */
export function loadPortableLexicalDocuments(
  projectId: string,
  dataRoot?: string,
): LexicalDocument[] | null {
  const entry = getOrCreateEntry(projectId, dataRoot);
  if (!entry) return null;
  if (entry.lexicalDocs) {
    askPerfSetLexicalCacheHit(true);
    askPerfNote(
      `portable lexical memory HIT (${entry.lexicalDocs.length} docs)`,
    );
    return entry.lexicalDocs;
  }
  askPerfSetLexicalCacheHit(false);
  const abs = path.join(
    portableSubdir(projectId, "lexical-index", entry.handle.dataRoot),
    "documents.jsonl",
  );
  const rows = readJsonlTracked<PortableLexicalDocument>(
    abs,
    "portable:lexical-index/documents.jsonl",
  );
  entry.lexicalDocs = rows.map(toLexicalDocument);
  askPerfNote(`portable lexical loaded: ${entry.lexicalDocs.length} docs`);
  return entry.lexicalDocs;
}

export function loadPortableEvidenceMaps(
  projectId: string,
  dataRoot?: string,
): {
  byId: Map<string, SearchDocument>;
  bySourceKey: Map<string, SearchDocument>;
} | null {
  const entry = getOrCreateEntry(projectId, dataRoot);
  if (!entry) return null;
  if (entry.evidenceById && entry.evidenceBySourceKey) {
    askPerfNote(
      `portable evidence memory HIT (${entry.evidenceById.size} docs)`,
    );
    return {
      byId: entry.evidenceById,
      bySourceKey: entry.evidenceBySourceKey,
    };
  }
  askPerfBegin("search_documents_load");
  const abs = path.join(
    portableSubdir(projectId, "evidence-store", entry.handle.dataRoot),
    "documents.jsonl",
  );
  const rows = readJsonlTracked<PortableEvidenceDocument>(
    abs,
    "portable:evidence-store/documents.jsonl",
  );
  const byId = new Map<string, SearchDocument>();
  const bySourceKey = new Map<string, SearchDocument>();
  for (const r of rows) {
    const doc = evidenceToSearchDocument(r);
    byId.set(doc.search_document_id, doc);
    bySourceKey.set(doc.source_key, doc);
  }
  entry.evidenceById = byId;
  entry.evidenceBySourceKey = bySourceKey;
  askPerfEnd("search_documents_load");
  askPerfNote(`portable evidence loaded: ${byId.size} docs`);
  return { byId, bySourceKey };
}

export function lookupPortableSymbols(
  projectId: string,
  names: string[],
  dataRoot?: string,
): Map<string, string[]> {
  const entry = getOrCreateEntry(projectId, dataRoot);
  const out = new Map<string, string[]>();
  if (!entry) return out;
  ensureSymbolMaps(entry);
  for (const name of names) {
    const key = name.trim().toUpperCase();
    const ids = entry.symbolsByName!.get(key);
    if (ids?.length) out.set(key, ids);
  }
  return out;
}

function pushSymbolName(
  map: Map<string, string[]>,
  name: string,
  documentId: string,
) {
  const key = name.trim().toUpperCase();
  if (!key || key.length < 2) return;
  const prev = map.get(key) ?? [];
  if (!prev.includes(documentId)) {
    prev.push(documentId);
    map.set(key, prev);
  }
}

/** Index bare tokens from compound SAP names (B|V1|ZECD → ZECD). */
function indexNameTokens(
  map: Map<string, string[]>,
  raw: string,
  documentId: string,
) {
  const upper = raw.toUpperCase();
  pushSymbolName(map, upper, documentId);
  for (const tok of upper.split(/[^A-Z0-9]+/)) {
    if (tok.length < 3) continue;
    pushSymbolName(map, tok, documentId);
  }
}

function ensureSymbolMaps(entry: CacheEntry): void {
  if (entry.symbolsByName && entry.symbolsById) return;
  askPerfBegin("symbol_lookup");
  const abs = path.join(
    portableSubdir(entry.handle.projectId, "symbol-index", entry.handle.dataRoot),
    "by_name.jsonl",
  );
  const absLex = path.join(
    portableSubdir(entry.handle.projectId, "symbol-index", entry.handle.dataRoot),
    "by_name_lexical.jsonl",
  );
  const map = new Map<string, string[]>();
  const byId = new Map<string, PortableSymbolRecord>();
  for (const file of [abs, absLex]) {
    for (const row of readJsonlTracked<PortableSymbolNamePosting>(
      file,
      `portable:${path.basename(file)}`,
    )) {
      for (const id of row.document_ids) {
        indexNameTokens(map, row.name, id);
      }
    }
  }
  const syms = readJsonlTracked<PortableSymbolRecord>(
    path.join(
      portableSubdir(entry.handle.projectId, "symbol-index", entry.handle.dataRoot),
      "symbols.jsonl",
    ),
    "portable:symbol-index/symbols.jsonl",
  );
  for (const s of syms) {
    byId.set(s.document_id, s);
    indexNameTokens(map, s.object_name, s.document_id);
    if (s.subobject_name) indexNameTokens(map, s.subobject_name, s.document_id);
    if (s.title) {
      // "output_type: ZECD" → ZECD
      const colon = s.title.split(":").pop()?.trim();
      if (colon) indexNameTokens(map, colon, s.document_id);
    }
  }
  entry.symbolsByName = map;
  entry.symbolsById = byId;
  askPerfNote(
    `portable symbol maps: ${map.size} names, ${byId.size} symbols`,
  );
  askPerfEnd("symbol_lookup");
}

/** Thin symbol records for document ids (no evidence full load). */
export function lookupPortableSymbolRecords(
  projectId: string,
  documentIds: string[],
  dataRoot?: string,
): PortableSymbolRecord[] {
  const entry = getOrCreateEntry(projectId, dataRoot);
  if (!entry) return [];
  ensureSymbolMaps(entry);
  const out: PortableSymbolRecord[] = [];
  for (const id of documentIds) {
    const rec = entry.symbolsById!.get(id);
    if (rec) out.push(rec);
  }
  return out;
}

export function lookupPortableCodeUsage(
  projectId: string,
  tokens: string[],
  dataRoot?: string,
): Map<string, PortableCodeUsagePosting["hits"]> {
  const entry = getOrCreateEntry(projectId, dataRoot);
  const out = new Map<string, PortableCodeUsagePosting["hits"]>();
  if (!entry) return out;
  if (!entry.codeUsageByToken) {
    const abs = path.join(
      portableSubdir(projectId, "symbol-index", entry.handle.dataRoot),
      "code_usage_postings.jsonl",
    );
    const map = new Map<string, PortableCodeUsagePosting["hits"]>();
    for (const row of readJsonlTracked<PortableCodeUsagePosting>(
      abs,
      "portable:symbol-index/code_usage_postings.jsonl",
    )) {
      map.set(row.token.toUpperCase(), row.hits);
    }
    entry.codeUsageByToken = map;
    askPerfNote(`portable code_usage postings: ${map.size} tokens`);
  }
  for (const t of tokens) {
    const key = t.trim().toUpperCase();
    const hits = entry.codeUsageByToken.get(key);
    if (hits?.length) out.set(key, hits);
  }
  return out;
}

export function loadPortableGraph(
  projectId: string,
  dataRoot?: string,
): {
  nodes: PortableGraphNode[];
  edges: PortableGraphEdge[];
  adjacency: NonNullable<CacheEntry["adjacency"]>;
} | null {
  const entry = getOrCreateEntry(projectId, dataRoot);
  if (!entry) return null;
  if (entry.graphNodes && entry.graphEdges && entry.adjacency) {
    return {
      nodes: entry.graphNodes,
      edges: entry.graphEdges,
      adjacency: entry.adjacency,
    };
  }
  askPerfBegin("graph_lookup");
  const dir = portableSubdir(projectId, "graph-index", entry.handle.dataRoot);
  entry.graphNodes = readJsonlTracked<PortableGraphNode>(
    path.join(dir, "nodes.jsonl"),
    "portable:graph-index/nodes.jsonl",
  );
  entry.graphEdges = readJsonlTracked<PortableGraphEdge>(
    path.join(dir, "edges.jsonl"),
    "portable:graph-index/edges.jsonl",
  );
  const adj = new Map<
    string,
    Array<{
      to_node_id: string;
      relation_type: string;
      occurrence_count: number;
      evidence_class: string;
    }>
  >();
  for (const row of readJsonlTracked<{
    node_id: string;
    neighbors: Array<{
      to_node_id: string;
      relation_type: string;
      occurrence_count: number;
      evidence_class: string;
    }>;
  }>(path.join(dir, "adjacency.jsonl"), "portable:graph-index/adjacency.jsonl")) {
    adj.set(row.node_id, row.neighbors);
  }
  entry.adjacency = adj;
  askPerfEnd("graph_lookup");
  return {
    nodes: entry.graphNodes,
    edges: entry.graphEdges,
    adjacency: adj,
  };
}

/**
 * Graph neighbors for confirmed technical seeds (exact object_name match).
 * Loads graph once (cached); no semantic expansion without seed.
 */
export function lookupPortableGraphNeighbors(params: {
  projectId: string;
  seedNames: string[];
  maxNeighborsPerSeed?: number;
  dataRoot?: string;
}): {
  seed_nodes: PortableGraphNode[];
  neighbor_nodes: PortableGraphNode[];
  edges: Array<{
    from: string;
    to: string;
    relation_type: string;
    evidence_class: string;
  }>;
} {
  const empty = {
    seed_nodes: [] as PortableGraphNode[],
    neighbor_nodes: [] as PortableGraphNode[],
    edges: [] as Array<{
      from: string;
      to: string;
      relation_type: string;
      evidence_class: string;
    }>,
  };
  const entry = getOrCreateEntry(params.projectId, params.dataRoot);
  if (!entry || params.seedNames.length === 0) return empty;
  const graph = loadPortableGraph(params.projectId, params.dataRoot);
  if (!graph) return empty;

  if (!entry.graphNodesByName) {
    const byName = new Map<string, PortableGraphNode[]>();
    for (const n of graph.nodes) {
      const key = n.object_name.toUpperCase();
      const list = byName.get(key) ?? [];
      list.push(n);
      byName.set(key, list);
      for (const tok of key.split(/[^A-Z0-9]+/)) {
        if (tok.length < 3) continue;
        const tList = byName.get(tok) ?? [];
        if (!tList.includes(n)) tList.push(n);
        byName.set(tok, tList);
      }
    }
    entry.graphNodesByName = byName;
  }

  const maxN = params.maxNeighborsPerSeed ?? 24;
  const seedNodes: PortableGraphNode[] = [];
  const neighborMap = new Map<string, PortableGraphNode>();
  const edges: Array<{
    from: string;
    to: string;
    relation_type: string;
    evidence_class: string;
  }> = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.node_id, n]));

  for (const raw of params.seedNames) {
    const key = raw.trim().toUpperCase();
    const seeds = entry.graphNodesByName.get(key) ?? [];
    for (const seed of seeds) {
      seedNodes.push(seed);
      const neighbors = graph.adjacency.get(seed.node_id) ?? [];
      let added = 0;
      for (const nb of neighbors) {
        if (added >= maxN) break;
        edges.push({
          from: seed.node_id,
          to: nb.to_node_id,
          relation_type: nb.relation_type,
          evidence_class: nb.evidence_class,
        });
        const node = nodeById.get(nb.to_node_id);
        if (node) neighborMap.set(node.node_id, node);
        added += 1;
      }
    }
  }

  askPerfNote(
    `graph neighbors: seeds=${seedNodes.length} neighbors=${neighborMap.size} edges=${edges.length}`,
  );
  return {
    seed_nodes: seedNodes,
    neighbor_nodes: [...neighborMap.values()],
    edges,
  };
}

/** Load only by_normalized (+ by_field). Never loads 249MB literals.jsonl on miss. */
function ensureLiteralValueIndex(entry: CacheEntry): void {
  if (entry.literalsValueIndexReady && entry.literalsByNormalized) return;
  askPerfBegin("literal_lookup");
  const dir = portableSubdir(
    entry.handle.projectId,
    "literal-index",
    entry.handle.dataRoot,
  );
  const byNorm = new Map<string, string[]>();
  for (const row of readJsonlTracked<PortableLiteralValuePosting>(
    path.join(dir, "by_normalized.jsonl"),
    "portable:literal-index/by_normalized.jsonl",
  )) {
    byNorm.set(row.normalized_value, row.literal_ids);
  }
  const byField = new Map<string, string[]>();
  for (const row of readJsonlTracked<PortableLiteralFieldPosting>(
    path.join(dir, "by_field.jsonl"),
    "portable:literal-index/by_field.jsonl",
  )) {
    byField.set(row.field_name.toUpperCase(), row.normalized_values);
  }
  entry.literalsByNormalized = byNorm;
  entry.literalsByField = byField;
  if (!entry.literalsById) entry.literalsById = new Map();
  entry.literalsValueIndexReady = true;
  askPerfNote(
    `portable literal value-index: ${byNorm.size} values, ${byField.size} fields (literals.jsonl deferred)`,
  );
  askPerfEnd("literal_lookup");
}

/** Stream literals.jsonl only for requested ids (hit path). */
function loadLiteralRecordsByIds(
  entry: CacheEntry,
  literalIds: string[],
): PortableLiteralRecord[] {
  if (literalIds.length === 0) return [];
  if (!entry.literalsById) entry.literalsById = new Map();
  const missing = literalIds.filter((id) => !entry.literalsById!.has(id));
  if (missing.length === 0) {
    return literalIds
      .map((id) => entry.literalsById!.get(id)!)
      .filter(Boolean);
  }
  const want = new Set(missing);
  const dir = portableSubdir(
    entry.handle.projectId,
    "literal-index",
    entry.handle.dataRoot,
  );
  const abs = path.join(dir, "literals.jsonl");
  askPerfNote(
    `literal records fetch: ${missing.length} ids (streaming literals.jsonl)`,
  );
  for (const row of readJsonlTracked<PortableLiteralRecord>(
    abs,
    "portable:literal-index/literals.jsonl",
  )) {
    if (!want.has(row.literal_id)) continue;
    entry.literalsById.set(row.literal_id, row);
    want.delete(row.literal_id);
    if (want.size === 0) break;
  }
  return literalIds
    .map((id) => entry.literalsById!.get(id)!)
    .filter(Boolean);
}

function normalizeLookupValue(raw: string): string {
  const t = raw.trim();
  if (/^\d+$/.test(t)) return t.replace(/^0+(?=\d)/, "") || "0";
  return t.toUpperCase();
}

/**
 * Deterministic exact literal lookup (no semantic Top-K).
 * Miss path: only by_normalized (~16MB once). Hit path may stream literals.jsonl.
 */
export function lookupPortableLiteralsExact(params: {
  projectId: string;
  value: string;
  boundField?: string;
  candidateRole?: PortableLiteralCandidateRole;
  includeComments?: boolean;
  limit?: number;
  dataRoot?: string;
}): PortableLiteralRecord[] {
  const entry = getOrCreateEntry(params.projectId, params.dataRoot);
  if (!entry) return [];
  ensureLiteralValueIndex(entry);
  const norm = normalizeLookupValue(params.value);
  const ids = entry.literalsByNormalized!.get(norm) ?? [];
  const altIds =
    /^\d+$/.test(params.value.trim()) && norm !== params.value.trim()
      ? entry.literalsByNormalized!.get(params.value.trim()) ?? []
      : [];
  const allIds = [...new Set([...ids, ...altIds])];
  if (allIds.length === 0) {
    askPerfNote(
      `literal exact lookup "${params.value}" → 0 hits (norm=${norm}, no literals.jsonl)`,
    );
    return [];
  }
  const limit = params.limit ?? 200;
  const records = loadLiteralRecordsByIds(entry, allIds.slice(0, limit * 2));
  const out: PortableLiteralRecord[] = [];
  for (const rec of records) {
    if (!params.includeComments && rec.in_comment) continue;
    if (
      params.boundField &&
      !rec.bound_fields.includes(params.boundField.toUpperCase())
    ) {
      continue;
    }
    if (
      params.candidateRole &&
      !rec.candidate_roles.includes(params.candidateRole)
    ) {
      continue;
    }
    out.push(rec);
    if (out.length >= limit) break;
  }
  askPerfNote(
    `literal exact lookup "${params.value}" → ${out.length} hits (norm=${norm})`,
  );
  return out;
}

/** List normalized values bound to a technical field (e.g. MATNR, VKORG). */
export function listPortableLiteralsByField(params: {
  projectId: string;
  fieldName: string;
  limit?: number;
  dataRoot?: string;
}): Array<{ normalized_value: string; occurrences: PortableLiteralRecord[] }> {
  const entry = getOrCreateEntry(params.projectId, params.dataRoot);
  if (!entry) return [];
  ensureLiteralValueIndex(entry);
  const field = params.fieldName.trim().toUpperCase();
  const values = entry.literalsByField!.get(field) ?? [];
  const limit = params.limit ?? 500;
  const out: Array<{
    normalized_value: string;
    occurrences: PortableLiteralRecord[];
  }> = [];
  for (const v of values.slice(0, limit)) {
    const occ = lookupPortableLiteralsExact({
      projectId: params.projectId,
      value: v,
      boundField: field,
      dataRoot: params.dataRoot,
      limit: 50,
    });
    if (occ.length) out.push({ normalized_value: v, occurrences: occ });
  }
  return out;
}

function evidenceOffsetsPath(entry: CacheEntry): string {
  return path.join(
    portableSubdir(
      entry.handle.projectId,
      "evidence-store",
      entry.handle.dataRoot,
    ),
    "id_offsets.jsonl",
  );
}

function evidenceDocumentsPath(entry: CacheEntry): string {
  return path.join(
    portableSubdir(
      entry.handle.projectId,
      "evidence-store",
      entry.handle.dataRoot,
    ),
    "documents.jsonl",
  );
}

/**
 * Ensure byte-offset map for targeted evidence fetch.
 * Builds once from documents.jsonl if missing (persisted sidecars).
 */
function ensureEvidenceOffsets(entry: CacheEntry): Map<string, number> {
  if (entry.evidenceOffsets) return entry.evidenceOffsets;
  const offsetFile = evidenceOffsetsPath(entry);
  const docsFile = evidenceDocumentsPath(entry);
  const map = new Map<string, number>();

  if (existsSync(offsetFile)) {
    for (const row of readJsonlTracked<{ document_id: string; offset: number }>(
      offsetFile,
      "portable:evidence-store/id_offsets.jsonl",
    )) {
      map.set(row.document_id, row.offset);
    }
    entry.evidenceOffsets = map;
    askPerfNote(`evidence offsets loaded: ${map.size}`);
    return map;
  }

  if (!existsSync(docsFile)) {
    entry.evidenceOffsets = map;
    return map;
  }

  askPerfBegin("search_documents_load");
  askPerfNote("building evidence id_offsets.jsonl (one-time)");
  const { parsed } = askPerfTrackedReadFile(
    docsFile,
    "portable:evidence-store/documents.jsonl",
    {
      parse: (raw) => {
        const buf = Buffer.from(raw, "utf8");
        const local = new Map<string, number>();
        const lines: string[] = [];
        let i = 0;
        while (i < buf.length) {
          let j = i;
          while (j < buf.length && buf[j] !== 0x0a) j += 1;
          const lineBuf = buf.subarray(i, j);
          if (lineBuf.length > 0) {
            try {
              const id = (
                JSON.parse(lineBuf.toString("utf8")) as { document_id?: string }
              ).document_id;
              if (id) {
                local.set(id, i);
                lines.push(JSON.stringify({ document_id: id, offset: i }));
              }
            } catch {
              // skip
            }
          }
          i = j < buf.length ? j + 1 : j;
        }
        return { map: local, lines };
      },
    },
  );
  const built = parsed as { map: Map<string, number>; lines: string[] } | null;
  if (built) {
    for (const [k, v] of built.map) map.set(k, v);
    try {
      mkdirSync(path.dirname(offsetFile), { recursive: true });
      writeFileSync(offsetFile, `${built.lines.join("\n")}\n`, "utf8");
    } catch {
      // non-fatal — keep in memory
    }
  }
  entry.evidenceOffsets = map;
  askPerfEnd("search_documents_load");
  askPerfNote(`evidence offsets built: ${map.size}`);
  return map;
}

/**
 * Targeted evidence fetch by document_id (seek via offsets when available).
 */
export function fetchPortableEvidenceByIds(
  projectId: string,
  documentIds: string[],
  dataRoot?: string,
): Map<string, SearchDocument> {
  const out = new Map<string, SearchDocument>();
  const entry = getOrCreateEntry(projectId, dataRoot);
  if (!entry || documentIds.length === 0) return out;

  if (!entry.evidenceById) entry.evidenceById = new Map();
  if (!entry.evidenceBySourceKey) entry.evidenceBySourceKey = new Map();

  const missing: string[] = [];
  for (const id of documentIds) {
    const cached = entry.evidenceById.get(id);
    if (cached) out.set(id, cached);
    else missing.push(id);
  }
  if (missing.length === 0) return out;

  const offsets = ensureEvidenceOffsets(entry);
  const docsFile = evidenceDocumentsPath(entry);
  if (!existsSync(docsFile)) return out;

  askPerfBegin("search_documents_load");
  const fd = openSync(docsFile, "r");
  try {
    for (const id of missing) {
      const off = offsets.get(id);
      if (off == null) continue;
      // Read a chunk large enough for one JSONL line
      const buf = Buffer.alloc(512 * 1024);
      const n = readSync(fd, buf, 0, buf.length, off);
      if (n <= 0) continue;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      const line = (nl >= 0 ? slice.subarray(0, nl) : slice).toString("utf8");
      try {
        const raw = JSON.parse(line) as PortableEvidenceDocument;
        const doc = evidenceToSearchDocument(raw);
        entry.evidenceById.set(doc.search_document_id, doc);
        entry.evidenceBySourceKey.set(doc.source_key, doc);
        out.set(doc.search_document_id, doc);
      } catch {
        // skip
      }
    }
  } finally {
    closeSync(fd);
  }
  askPerfNote(
    `targeted evidence fetch: asked=${documentIds.length} got=${out.size} (seek)`,
  );
  askPerfEnd("search_documents_load");
  return out;
}

export function portableIndexStats(projectId: string, dataRoot?: string) {
  const m = loadPortableManifest(projectId, dataRoot);
  if (!m) return null;
  const root = dataRoot ?? getLocalDataRoot();
  const sizes: Record<string, number> = {};
  for (const [key, rel] of Object.entries(m.paths)) {
    const abs = path.join(root, projectId, rel);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        let sum = 0;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readdirSync } = require("fs") as typeof import("fs");
        for (const f of readdirSync(abs)) {
          const p = path.join(abs, f);
          if (statSync(p).isFile()) sum += statSync(p).size;
        }
        sizes[key] = sum;
      }
    } catch {
      sizes[key] = 0;
    }
  }
  return { manifest: m, sizes };
}
