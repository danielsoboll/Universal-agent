import { createHash } from "crypto";
import {
  buildSearchText,
  normalizeSearchToken,
} from "@/lib/search/buildSearchText";
import {
  SEARCH_DOCUMENT_VERSION,
  searchDocumentSchema,
  type SearchDocument,
  type SearchDocumentContentPayload,
  type SearchEntity,
  type SearchEvidence,
  type SearchRelation,
} from "@/lib/search/searchDocumentSchema";

/** Generic draft before id/hash/timestamps — source-agnostic. */
export type SearchDocumentDraft = {
  source_system: string;
  source_type: string;
  source_key: string;
  knowledge_unit_type: string;
  object_type?: string;
  object_name?: string;
  subobject_name?: string;
  title: string;
  technical_summary?: string;
  business_purpose?: string;
  facts?: string[];
  inferences?: string[];
  entities?: SearchEntity[];
  relations?: SearchRelation[];
  tables_read?: string[];
  tables_written?: string[];
  called_methods?: string[];
  called_functions?: string[];
  macro_calls?: string[];
  hardcoded_values?: string[];
  external_interfaces?: string[];
  risks?: string[];
  evidence?: SearchEvidence[];
  confidence?: number | null;
  analysis_version?: string;
  metadata?: Record<string, unknown>;
};

function cleanList(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v) => v.length > 0),
    ),
  ];
}

function shortEvidenceHints(evidence: SearchEvidence[]): string[] {
  const hints: string[] = [];
  for (const e of evidence) {
    const lineNos = (e.lines ?? [])
      .map((l) => l.line)
      .filter((n): n is number => typeof n === "number" && n > 0);
    const uniq = [...new Set(lineNos)].slice(0, 3);
    if (uniq.length === 0) continue;
    const kind =
      e.statement_type === "fact"
        ? "FACT"
        : e.statement_type === "inference"
          ? "INFERENCE"
          : "EVIDENCE";
    hints.push(`${kind}@L${uniq.join(",")}`);
    if (hints.length >= 12) break;
  }
  return hints;
}

export function buildSearchDocumentId(draft: {
  source_system: string;
  knowledge_unit_type: string;
  source_key: string;
}): string {
  const material = [
    draft.source_system.trim(),
    draft.knowledge_unit_type.trim(),
    draft.source_key.trim(),
  ].join("|");
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `sd_${digest.slice(0, 32)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function hashSearchDocumentContent(
  payload: SearchDocumentContentPayload,
): string {
  return createHash("sha256")
    .update(stableStringify(payload), "utf8")
    .digest("hex");
}

function toContentPayload(
  draft: SearchDocumentDraft,
): SearchDocumentContentPayload {
  return {
    source_system: draft.source_system.trim(),
    source_type: draft.source_type.trim(),
    source_key: draft.source_key.trim(),
    knowledge_unit_type: draft.knowledge_unit_type.trim(),
    object_type: (draft.object_type ?? "").trim(),
    object_name: (draft.object_name ?? "").trim(),
    subobject_name: (draft.subobject_name ?? "").trim(),
    title: normalizeSearchToken(draft.title),
    technical_summary: (draft.technical_summary ?? "").trim(),
    business_purpose: (draft.business_purpose ?? "").trim(),
    facts: cleanList(draft.facts),
    inferences: cleanList(draft.inferences),
    entities: (draft.entities ?? [])
      .map((e) => ({
        kind: e.kind.trim(),
        name: e.name.trim(),
        ...(e.normalized ? { normalized: e.normalized.trim() } : {}),
      }))
      .filter((e) => e.kind && e.name)
      .sort((a, b) =>
        `${a.kind}|${a.name}`.localeCompare(`${b.kind}|${b.name}`),
      ),
    relations: (draft.relations ?? [])
      .map((r) => ({
        relation_type: r.relation_type.trim(),
        ...(r.from_type ? { from_type: r.from_type.trim() } : {}),
        ...(r.from_name ? { from_name: r.from_name.trim() } : {}),
        ...(r.to_type ? { to_type: r.to_type.trim() } : {}),
        ...(r.to_name ? { to_name: r.to_name.trim() } : {}),
      }))
      .filter((r) => r.relation_type)
      .sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    tables_read: cleanList(draft.tables_read),
    tables_written: cleanList(draft.tables_written),
    called_methods: cleanList(draft.called_methods),
    called_functions: cleanList(draft.called_functions),
    macro_calls: cleanList(draft.macro_calls),
    hardcoded_values: cleanList(draft.hardcoded_values),
    external_interfaces: cleanList(draft.external_interfaces),
    risks: cleanList(draft.risks),
    evidence: draft.evidence ?? [],
    confidence:
      typeof draft.confidence === "number" ? draft.confidence : null,
    analysis_version: (draft.analysis_version ?? "").trim(),
    metadata: {
      search_document_version: SEARCH_DOCUMENT_VERSION,
      ...(draft.metadata ?? {}),
    },
  };
}

/**
 * Materialize a SearchDocument from a generic draft.
 * Preserves created_at when updating an existing unchanged-or-changed doc.
 */
export function materializeSearchDocument(params: {
  draft: SearchDocumentDraft;
  existing?: SearchDocument | null;
  now?: string;
}): {
  document: SearchDocument;
  unchanged: boolean;
} {
  const now = params.now ?? new Date().toISOString();
  const content = toContentPayload(params.draft);
  const content_hash = hashSearchDocumentContent(content);
  const search_document_id = buildSearchDocumentId(params.draft);

  if (
    params.existing &&
    params.existing.search_document_id === search_document_id &&
    params.existing.content_hash === content_hash
  ) {
    return { document: params.existing, unchanged: true };
  }

  const evidence = content.evidence;
  const search_text = buildSearchText({
    title: content.title,
    object_type: content.object_type,
    object_name: content.object_name,
    subobject_name: content.subobject_name,
    source_key: content.source_key,
    knowledge_unit_type: content.knowledge_unit_type,
    business_purpose: content.business_purpose,
    technical_summary: content.technical_summary,
    facts: content.facts,
    inferences: content.inferences,
    tables_read: content.tables_read,
    tables_written: content.tables_written,
    called_methods: content.called_methods,
    called_functions: content.called_functions,
    macro_calls: content.macro_calls,
    hardcoded_values: content.hardcoded_values,
    external_interfaces: content.external_interfaces,
    risks: content.risks,
    relations: content.relations,
    entities: content.entities,
    evidence_hints: shortEvidenceHints(evidence),
  });

  const document = searchDocumentSchema.parse({
    ...content,
    search_document_id,
    content_hash,
    search_text,
    created_at: params.existing?.created_at ?? now,
    updated_at: now,
  });

  return { document, unchanged: false };
}

export function parseSearchDocumentsJsonl(
  text: string,
): Map<string, SearchDocument> {
  const map = new Map<string, SearchDocument>();
  if (!text.trim()) return map;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const parsed = searchDocumentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    map.set(parsed.data.search_document_id, parsed.data);
  }
  return map;
}

export function searchDocumentsToJsonl(docs: Iterable<SearchDocument>): string {
  const rows = [...docs];
  if (rows.length === 0) return "";
  return `${rows.map((d) => JSON.stringify(d)).join("\n")}\n`;
}
