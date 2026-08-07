/**
 * ACCESS INDICES builder only (pipeline stage: access_indices).
 *
 * Does NOT replace RAW/Canonical/Graph. Does NOT invent fachliche Wahrheit.
 * Does NOT run OpenAI. Consumes today's canonical/search via adapters
 * (see knowledgeRecord.ts + adapters/canonicalAdapters.ts).
 *
 *   RAW → normalization → Canonical → Cross-links/KG
 *     → ACCESS INDICES (this module)
 *     → Embeddings (optional, lazy)
 *     → Ask
 *
 * Streams large JSONL → P01/indexes/{symbol,literal,lexical,graph,evidence,vector}-*
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import { buildLexicalCorpus } from "@/lib/search/lexical/buildCorpus";
import {
  atomicWriteText,
  createAtomicJsonlWriter,
  forEachJsonlLine,
  hashFileStreaming,
  sourcesFingerprint,
  stampRelativeSource,
} from "@/lib/portableIndex/io";
import {
  portableIndexRoot,
  portableManifestPath,
  portableSubdir,
  toProjectRelative,
} from "@/lib/portableIndex/paths";
import {
  PORTABLE_INDEX_VERSION,
  type PortableCodeUsagePosting,
  type PortableEvidenceDocument,
  type PortableGraphEdge,
  type PortableGraphNode,
  type PortableIndexManifest,
  type PortableLexicalDocument,
  type PortableSourceStamp,
  type PortableSymbolRecord,
  type PortableVectorManifest,
  type PortableVectorRef,
} from "@/lib/portableIndex/types";
import type {
  PortableLiteralFieldPosting,
  PortableLiteralValuePosting,
} from "@/lib/portableIndex/literalTypes";
import { extractLiteralsFromAbap } from "@/lib/portableIndex/extractLiterals";
import {
  ACCESS_INDEX_STAGE,
  KNOWLEDGE_RECORD_VERSION,
} from "@/lib/portableIndex/knowledgeRecord";
import { ACCESS_INDEX_ADAPTERS } from "@/lib/portableIndex/adapters/canonicalAdapters";

export type BuildPortableIndexParams = {
  projectId: string;
  systemId: string;
  dataRoot?: string;
  /** Force rebuild even if sources fingerprint unchanged. */
  force?: boolean;
};

export type BuildPortableIndexResult = {
  ok: boolean;
  skipped: boolean;
  manifest_path: string;
  manifest: PortableIndexManifest | null;
  message: string;
  duration_ms: number;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function snippetAround(source: string, needle: string, radius = 200): string {
  const upper = source.toUpperCase();
  const n = needle.toUpperCase();
  const i = upper.indexOf(n);
  if (i < 0) return source.slice(0, radius * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, i - radius);
  const end = Math.min(source.length, i + n.length + radius);
  return source.slice(start, end).replace(/\s+/g, " ").trim();
}

function extractCodeTokens(source: string): string[] {
  const out = new Set<string>();
  const re = /\b([ZY][A-Z0-9_]{2,}|[A-Z][A-Z0-9_]{2,}-[A-Z][A-Z0-9_]{1,})\b/g;
  const upper = source.toUpperCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(upper))) {
    const t = m[1]!;
    if (t.length >= 4 && t.length <= 40) out.add(t);
    if (out.size >= 80) break;
  }
  return [...out];
}

async function collectSourceStamp(
  projectId: string,
  dataRoot: string,
  relativePath: string,
): Promise<PortableSourceStamp | null> {
  const abs = path.join(dataRoot, projectId, ...relativePath.split("/"));
  if (!existsSync(abs)) return null;
  const content_hash = await hashFileStreaming(abs);
  return stampRelativeSource({
    absolutePath: abs,
    relativePath,
    contentHash: content_hash,
  });
}

async function collectBuildSources(
  projectId: string,
  dataRoot: string,
): Promise<PortableSourceStamp[]> {
  const rels: string[] = [
    "indexes/search/search_documents.jsonl",
    "indexes/search/exact_index.json",
    "indexes/search/fulltext_index.json",
    "indexes/search/metadata_index.json",
    "indexes/search/relation_index.json",
    "indexes/search/vector_index.jsonl",
    "indexes/search/index_manifest.json",
    "embeddings/search/search_embeddings.jsonl",
    "canonical/knowledge-graph/nodes.jsonl",
    "canonical/knowledge-graph/edges.jsonl",
    "canonical/control-tables/table_definitions.jsonl",
    "canonical/control-tables/table_entities.jsonl",
    "canonical/control-tables/table_classifications.jsonl",
    "canonical/message-idoc-config/objects.jsonl",
    "canonical/classes/code_units.jsonl",
    "canonical/programs/code_units.jsonl",
    "canonical/function-modules/code_units.jsonl",
  ];

  // master-data structure files
  const mdRoot = path.join(dataRoot, projectId, "canonical", "master-data");
  if (existsSync(mdRoot)) {
    for (const domain of ["customers", "materials", "vendors"]) {
      const domainDir = path.join(mdRoot, domain);
      if (!existsSync(domainDir) || !statSync(domainDir).isDirectory()) continue;
      for (const table of readdirSync(domainDir)) {
        rels.push(`canonical/master-data/${domain}/${table}/structure.jsonl`);
      }
    }
  }

  const stamps: PortableSourceStamp[] = [];
  for (const rel of rels) {
    const s = await collectSourceStamp(projectId, dataRoot, rel);
    if (s) stamps.push(s);
  }
  return stamps;
}

function evidenceFromSearchDoc(
  raw: Record<string, unknown>,
  projectId: string,
  systemId: string,
): PortableEvidenceDocument | null {
  const document_id = asString(raw.search_document_id);
  const source_key = asString(raw.source_key);
  if (!document_id || !source_key) return null;
  const meta = (raw.metadata as Record<string, unknown>) ?? {};
  let source_path: string | undefined;
  const sp = asString(meta.source_path) || asString(raw.source_path);
  if (sp) {
    source_path = sp.includes(projectId)
      ? toProjectRelative(projectId, sp)
      : sp.replace(/^\/+/, "");
  }
  return {
    document_id,
    source_key,
    project_id: projectId,
    system_id: systemId || asString(raw.source_system) || "unknown",
    content_hash: asString(raw.content_hash) || "unknown",
    source_path,
    knowledge_unit_type: asString(raw.knowledge_unit_type),
    object_type: asString(raw.object_type),
    object_name: asString(raw.object_name),
    subobject_name: asString(raw.subobject_name),
    title: asString(raw.title) || source_key,
    technical_summary: asString(raw.technical_summary),
    business_purpose: asString(raw.business_purpose),
    facts: Array.isArray(raw.facts) ? (raw.facts as string[]) : [],
    inferences: Array.isArray(raw.inferences) ? (raw.inferences as string[]) : [],
    tables_read: Array.isArray(raw.tables_read)
      ? (raw.tables_read as string[])
      : [],
    tables_written: Array.isArray(raw.tables_written)
      ? (raw.tables_written as string[])
      : [],
    called_methods: Array.isArray(raw.called_methods)
      ? (raw.called_methods as string[])
      : [],
    called_functions: Array.isArray(raw.called_functions)
      ? (raw.called_functions as string[])
      : [],
    hardcoded_values: Array.isArray(raw.hardcoded_values)
      ? (raw.hardcoded_values as string[])
      : [],
    evidence: Array.isArray(raw.evidence)
      ? (raw.evidence as PortableEvidenceDocument["evidence"])
      : [],
    entities: Array.isArray(raw.entities)
      ? (raw.entities as PortableEvidenceDocument["entities"])
      : [],
    relations: Array.isArray(raw.relations)
      ? (raw.relations as PortableEvidenceDocument["relations"])
      : [],
    confidence:
      typeof raw.confidence === "number"
        ? raw.confidence
        : raw.confidence == null
          ? null
          : null,
    search_text: asString(raw.search_text),
    metadata: meta,
    analysis_version: asString(raw.analysis_version),
    source_system: asString(raw.source_system),
    source_type: asString(raw.source_type),
    created_at: asString(raw.created_at),
    updated_at: asString(raw.updated_at),
  };
}

function pushName(
  map: Map<string, Set<string>>,
  name: string,
  documentId: string,
) {
  const n = name.trim().toUpperCase();
  if (n.length < 2) return;
  let set = map.get(n);
  if (!set) {
    set = new Set();
    map.set(n, set);
  }
  set.add(documentId);
}

export async function buildPortableIndex(
  params: BuildPortableIndexParams,
): Promise<BuildPortableIndexResult> {
  const started = Date.now();
  const projectId = params.projectId.trim();
  const systemId = params.systemId.trim() || "unknown";
  const dataRoot = params.dataRoot ?? getLocalDataRoot();
  const manifestPath = portableManifestPath(projectId, dataRoot);

  const sources = await collectBuildSources(projectId, dataRoot);
  const fp = sourcesFingerprint(sources);

  if (!params.force && existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as PortableIndexManifest;
      if (prev.sources_fingerprint === fp) {
        return {
          ok: true,
          skipped: true,
          manifest_path: manifestPath,
          manifest: prev,
          message: "Unverändert — portable Index übersprungen (fingerprint match).",
          duration_ms: Date.now() - started,
        };
      }
    } catch {
      // rebuild
    }
  }

  const root = portableIndexRoot(projectId, dataRoot);
  mkdirSync(root, { recursive: true });
  for (const name of [
    "symbol-index",
    "lexical-index",
    "graph-index",
    "evidence-store",
    "vector-index",
    "literal-index",
  ] as const) {
    mkdirSync(portableSubdir(projectId, name, dataRoot), { recursive: true });
  }

  const notes: string[] = [
    `pipeline_stage=${ACCESS_INDEX_STAGE}`,
    `knowledge_record_version=${KNOWLEDGE_RECORD_VERSION}`,
    `adapters=${ACCESS_INDEX_ADAPTERS.map((a) => a.id).join(",")}`,
    "Access indices only — does not replace RAW/Canonical/KG.",
  ];
  const nameToIds = new Map<string, Set<string>>();
  let symbolCount = 0;
  let evidenceCount = 0;
  let lexicalDocCount = 0;
  let tokenPostingCount = 0;
  let graphNodeCount = 0;
  let graphEdgeCount = 0;
  let vectorRefCount = 0;
  let codeUsagePostingCount = 0;
  let literalCount = 0;
  let literalValuePostingCount = 0;

  // --- evidence-store + symbol-index from search_documents ---
  const docsPath = path.join(
    dataRoot,
    projectId,
    "indexes",
    "search",
    "search_documents.jsonl",
  );
  const evidenceWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "evidence-store", dataRoot),
      "documents.jsonl",
    ),
  );
  const symbolWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "symbol-index", dataRoot),
      "symbols.jsonl",
    ),
  );

  if (existsSync(docsPath)) {
    await forEachJsonlLine(docsPath, (line) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const ev = evidenceFromSearchDoc(raw, projectId, systemId);
      if (!ev) return;
      evidenceWriter.write(ev);
      evidenceCount += 1;

      const sym: PortableSymbolRecord = {
        document_id: ev.document_id,
        source_key: ev.source_key,
        project_id: projectId,
        system_id: ev.system_id,
        object_type: ev.object_type,
        object_name: ev.object_name,
        subobject_name: ev.subobject_name || undefined,
        knowledge_unit_type: ev.knowledge_unit_type,
        title: ev.title,
        content_hash: ev.content_hash,
      };
      symbolWriter.write(sym);
      symbolCount += 1;
      pushName(nameToIds, ev.object_name, ev.document_id);
      if (ev.subobject_name) {
        pushName(nameToIds, ev.subobject_name, ev.document_id);
        pushName(
          nameToIds,
          `${ev.object_name}-${ev.subobject_name}`,
          ev.document_id,
        );
      }
    });
  } else {
    notes.push("search_documents.jsonl fehlt — evidence/symbol leer");
  }
  await evidenceWriter.end();
  await symbolWriter.end();

  const byNameWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "symbol-index", dataRoot),
      "by_name.jsonl",
    ),
  );
  for (const [name, ids] of nameToIds) {
    byNameWriter.write({ name, document_ids: [...ids] });
  }
  await byNameWriter.end();

  // --- lexical-index from existing buildLexicalCorpus (once at build time) ---
  const lexicalDocs = buildLexicalCorpus(projectId);
  const lexDocWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "lexical-index", dataRoot),
      "documents.jsonl",
    ),
  );
  const tokenToIds = new Map<string, Set<string>>();
  for (const doc of lexicalDocs) {
    const source_path = doc.source_path.includes(path.sep)
      ? toProjectRelative(
          projectId,
          path.isAbsolute(doc.source_path)
            ? doc.source_path
            : path.join(dataRoot, projectId, doc.source_path),
          dataRoot,
        ) || doc.source_path.replace(/\\/g, "/")
      : doc.source_path.replace(/\\/g, "/");
    const rec: PortableLexicalDocument = {
      id: doc.id,
      kind: doc.kind,
      technical_name: doc.technical_name,
      title: doc.title,
      search_text: doc.search_text.slice(0, 2000),
      table_name: doc.table_name,
      field_name: doc.field_name,
      field_text: doc.field_text,
      table_text: doc.table_text,
      data_element: doc.data_element,
      data_element_text: doc.data_element_text,
      domain: doc.domain,
      domain_text: doc.domain_text,
      append_include: doc.append_include,
      source_path,
      code_summary: doc.code_summary?.slice(0, 500),
    };
    lexDocWriter.write(rec);
    lexicalDocCount += 1;
    pushName(nameToIds, doc.technical_name, doc.id);
    for (const tok of doc.technical_name
      .toUpperCase()
      .split(/[^A-Z0-9_]+/)) {
      const t = tok.trim();
      if (t.length < 3) continue;
      let set = tokenToIds.get(t);
      if (!set) {
        set = new Set();
        tokenToIds.set(t, set);
      }
      set.add(doc.id);
    }
  }
  await lexDocWriter.end();

  const tokenWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "lexical-index", dataRoot),
      "token_postings.jsonl",
    ),
  );
  for (const [token, ids] of tokenToIds) {
    // Cap posting lists to keep file compact
    tokenWriter.write({
      token,
      document_ids: [...ids].slice(0, 200),
    });
    tokenPostingCount += 1;
  }
  await tokenWriter.end();

  // Append lexical technical names into by_name (rewrite already closed — append extra file)
  const byNameExtra = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "symbol-index", dataRoot),
      "by_name_lexical.jsonl",
    ),
  );
  const lexicalNames = new Map<string, Set<string>>();
  for (const doc of lexicalDocs) {
    pushName(lexicalNames, doc.technical_name, doc.id);
  }
  for (const [name, ids] of lexicalNames) {
    byNameExtra.write({ name, document_ids: [...ids] });
  }
  await byNameExtra.end();

  // --- code usage + literal-index (single stream over code_units) ---
  const codeUsage = new Map<
    string,
    PortableCodeUsagePosting["hits"]
  >();
  const literalWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "literal-index", dataRoot),
      "literals.jsonl",
    ),
  );
  const valueToLiteralIds = new Map<string, Set<string>>();
  const valueBoundFields = new Map<string, Set<string>>();
  const fieldToValues = new Map<string, Set<string>>();

  for (const zone of ["classes", "programs", "function-modules"] as const) {
    let unitsPath: string;
    try {
      unitsPath = resolveProjectZonePath(
        projectId,
        "canonical",
        zone,
        "code_units.jsonl",
      );
    } catch {
      continue;
    }
    if (!existsSync(unitsPath)) continue;
    const source_path_rel = `canonical/${zone}/code_units.jsonl`;
    await forEachJsonlLine(unitsPath, (line) => {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const source_key = asString(rec.source_key);
      const source = asString(rec.source_code);
      if (!source_key || !source) return;
      const object =
        asString(rec.object_name) ||
        asString(rec.class_name) ||
        asString(rec.name);
      const method =
        asString(rec.method_name) ||
        asString(rec.form_name) ||
        asString(rec.subobject_name);
      const className = asString(rec.class_name);
      const objectType =
        asString(rec.object_type) ||
        asString(rec.unit_type) ||
        zone.toUpperCase();
      const code_unit_id =
        asString(rec.unit_id) ||
        asString(rec.id) ||
        source_key;

      for (const token of extractCodeTokens(source)) {
        let hits = codeUsage.get(token);
        if (!hits) {
          hits = [];
          codeUsage.set(token, hits);
        }
        if (hits.length >= 40) continue;
        if (hits.some((h) => h.source_key === source_key)) continue;
        hits.push({
          source_key,
          zone,
          object_name: object,
          method_or_routine: method,
          snippet: snippetAround(source, token, 180).slice(0, 500),
        });
      }

      const literals = extractLiteralsFromAbap(source, {
        project_id: projectId,
        system_id: systemId,
        source_key,
        source_path: source_path_rel,
        object_type: objectType,
        object_name: object,
        program_or_include:
          zone === "programs" ? object : asString(rec.include_name) || undefined,
        class_name: className || undefined,
        method_or_routine: method || undefined,
        code_unit_id,
      });
      for (const lit of literals) {
        literalWriter.write(lit);
        literalCount += 1;
        let ids = valueToLiteralIds.get(lit.normalized_value);
        if (!ids) {
          ids = new Set();
          valueToLiteralIds.set(lit.normalized_value, ids);
        }
        ids.add(lit.literal_id);
        if (lit.bound_fields.length) {
          let bf = valueBoundFields.get(lit.normalized_value);
          if (!bf) {
            bf = new Set();
            valueBoundFields.set(lit.normalized_value, bf);
          }
          for (const f of lit.bound_fields) bf.add(f);
          for (const f of lit.bound_fields) {
            let vs = fieldToValues.get(f);
            if (!vs) {
              vs = new Set();
              fieldToValues.set(f, vs);
            }
            vs.add(lit.normalized_value);
          }
        }
      }
    });
  }
  await literalWriter.end();

  const byValueWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "literal-index", dataRoot),
      "by_normalized.jsonl",
    ),
  );
  for (const [normalized_value, ids] of valueToLiteralIds) {
    const posting: PortableLiteralValuePosting = {
      normalized_value,
      literal_ids: [...ids].slice(0, 500),
      bound_fields: [...(valueBoundFields.get(normalized_value) ?? [])],
      occurrence_count: ids.size,
    };
    byValueWriter.write(posting);
    literalValuePostingCount += 1;
  }
  await byValueWriter.end();

  const byFieldWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "literal-index", dataRoot),
      "by_field.jsonl",
    ),
  );
  for (const [field_name, values] of fieldToValues) {
    const posting: PortableLiteralFieldPosting = {
      field_name,
      normalized_values: [...values].slice(0, 5000),
      occurrence_count: values.size,
    };
    byFieldWriter.write(posting);
  }
  await byFieldWriter.end();

  const codeWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "symbol-index", dataRoot),
      "code_usage_postings.jsonl",
    ),
  );
  for (const [token, hits] of codeUsage) {
    if (hits.length === 0) continue;
    codeWriter.write({ token, hits } satisfies PortableCodeUsagePosting);
    codeUsagePostingCount += 1;
  }
  await codeWriter.end();
  notes.push(
    `code_usage_postings: ${codeUsagePostingCount} tokens; literals: ${literalCount} (exact index)`,
  );

  // --- graph-index (compact, stream) ---
  const nodesPath = path.join(
    dataRoot,
    projectId,
    "canonical",
    "knowledge-graph",
    "nodes.jsonl",
  );
  const edgesPath = path.join(
    dataRoot,
    projectId,
    "canonical",
    "knowledge-graph",
    "edges.jsonl",
  );
  const nodeWriter = createAtomicJsonlWriter(
    path.join(portableSubdir(projectId, "graph-index", dataRoot), "nodes.jsonl"),
  );
  if (existsSync(nodesPath)) {
    await forEachJsonlLine(nodesPath, (line) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const node_id = asString(raw.node_id);
      if (!node_id) return;
      const evidence = (raw.evidence as Record<string, unknown>) ?? {};
      const node: PortableGraphNode = {
        node_id,
        project_id: projectId,
        system_id: asString(raw.system_id) || systemId,
        object_type: asString(raw.object_type),
        object_name: asString(raw.name) || asString(raw.identity_key),
        authoritative_existence: Boolean(evidence.authoritative_existence),
        code_usage: Boolean(evidence.code_usage),
      };
      nodeWriter.write(node);
      graphNodeCount += 1;
    });
  }
  await nodeWriter.end();

  const edgeWriter = createAtomicJsonlWriter(
    path.join(portableSubdir(projectId, "graph-index", dataRoot), "edges.jsonl"),
  );
  const adjacency = new Map<
    string,
    Array<{
      to_node_id: string;
      relation_type: string;
      occurrence_count: number;
      evidence_class: string;
    }>
  >();
  if (existsSync(edgesPath)) {
    await forEachJsonlLine(edgesPath, (line) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const from_node_id = asString(raw.from_node_id);
      const to_node_id = asString(raw.to_node_id);
      if (!from_node_id || !to_node_id) return;
      const evidence_class = asString(raw.evidence_class) || "unresolved";
      const edge: PortableGraphEdge = {
        edge_id: asString(raw.edge_id) || `${from_node_id}>${to_node_id}`,
        project_id: projectId,
        system_id: systemId,
        from_node_id,
        to_node_id,
        relation_type:
          asString(raw.relation_unified) || asString(raw.relation_type),
        occurrence_count:
          typeof raw.occurrence_count === "number" ? raw.occurrence_count : 1,
        evidence_class,
        authoritative: Boolean(raw.authoritative),
        resolution: asString(raw.resolution) || undefined,
      };
      edgeWriter.write(edge);
      graphEdgeCount += 1;
      let adj = adjacency.get(from_node_id);
      if (!adj) {
        adj = [];
        adjacency.set(from_node_id, adj);
      }
      if (adj.length < 100) {
        adj.push({
          to_node_id,
          relation_type: edge.relation_type,
          occurrence_count: edge.occurrence_count,
          evidence_class: edge.evidence_class,
        });
      }
    });
  }
  await edgeWriter.end();

  const adjWriter = createAtomicJsonlWriter(
    path.join(
      portableSubdir(projectId, "graph-index", dataRoot),
      "adjacency.jsonl",
    ),
  );
  for (const [node_id, neighbors] of adjacency) {
    adjWriter.write({ node_id, neighbors });
  }
  await adjWriter.end();

  // --- vector-index capsule (thin refs only; do not touch embeddings file) ---
  const vectorSrc = path.join(
    dataRoot,
    projectId,
    "indexes",
    "search",
    "vector_index.jsonl",
  );
  const vecWriter = createAtomicJsonlWriter(
    path.join(portableSubdir(projectId, "vector-index", dataRoot), "refs.jsonl"),
  );
  let dims = 0;
  if (existsSync(vectorSrc)) {
    await forEachJsonlLine(vectorSrc, (line) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const ref: PortableVectorRef = {
        document_id: asString(raw.search_document_id),
        source_key: asString(raw.source_key),
        content_hash: asString(raw.content_hash),
        dimensions:
          typeof raw.dimensions === "number" ? raw.dimensions : 0,
      };
      if (!ref.document_id) return;
      if (ref.dimensions) dims = ref.dimensions;
      vecWriter.write(ref);
      vectorRefCount += 1;
    });
  }
  await vecWriter.end();

  let embModel = "";
  let embVersion = "";
  const searchManifestPath = path.join(
    dataRoot,
    projectId,
    "indexes",
    "search",
    "index_manifest.json",
  );
  if (existsSync(searchManifestPath)) {
    try {
      const m = JSON.parse(readFileSync(searchManifestPath, "utf8")) as {
        embedding_model?: string;
        embedding_version?: string;
        dimensions?: number;
      };
      embModel = m.embedding_model ?? "";
      embVersion = m.embedding_version ?? "";
      if (m.dimensions) dims = m.dimensions;
    } catch {
      // ignore
    }
  }

  const vectorManifest: PortableVectorManifest = {
    schema_version: PORTABLE_INDEX_VERSION,
    project_id: projectId,
    system_id: systemId,
    embeddings_relative_path: "embeddings/search/search_embeddings.jsonl",
    embedding_model: embModel,
    embedding_version: embVersion,
    dimensions: dims,
    ref_count: vectorRefCount,
    note: "Embeddings bleiben unter embeddings/; bei enableVector=false nicht laden.",
  };
  atomicWriteText(
    path.join(
      portableSubdir(projectId, "vector-index", dataRoot),
      "manifest.json",
    ),
    JSON.stringify(vectorManifest, null, 2),
  );

  const manifest: PortableIndexManifest = {
    schema_version: PORTABLE_INDEX_VERSION,
    project_id: projectId,
    system_id: systemId,
    built_at: new Date().toISOString(),
    builder: "buildPortableIndex",
    sources_fingerprint: fp,
    sources,
    counts: {
      symbols: symbolCount,
      lexical_documents: lexicalDocCount,
      lexical_token_postings: tokenPostingCount,
      graph_nodes: graphNodeCount,
      graph_edges: graphEdgeCount,
      evidence_documents: evidenceCount,
      vector_refs: vectorRefCount,
      code_usage_postings: codeUsagePostingCount,
      literals: literalCount,
      literal_value_postings: literalValuePostingCount,
    },
    paths: {
      symbol_index: "indexes/symbol-index",
      lexical_index: "indexes/lexical-index",
      graph_index: "indexes/graph-index",
      evidence_store: "indexes/evidence-store",
      vector_index: "indexes/vector-index",
      literal_index: "indexes/literal-index",
    },
    notes,
  };
  atomicWriteText(manifestPath, JSON.stringify(manifest, null, 2));
  atomicWriteText(
    path.join(root, "portable-sources.json"),
    JSON.stringify({ fingerprint: fp, sources }, null, 2),
  );

  return {
    ok: true,
    skipped: false,
    manifest_path: manifestPath,
    manifest,
    message: `Portable Index gebaut: evidence=${evidenceCount}, lexical=${lexicalDocCount}, symbols=${symbolCount}, literals=${literalCount}, graph=${graphNodeCount}/${graphEdgeCount}, code_usage=${codeUsagePostingCount}`,
    duration_ms: Date.now() - started,
  };
}
