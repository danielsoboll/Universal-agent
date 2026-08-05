/**
 * Adapter: message-idoc canonical objects → SearchDocument drafts.
 */
import type { CanonicalObject } from "@/lib/ingest/messageIdocCanonical";
import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";

export function draftFromMessageIdocObject(params: {
  object: CanonicalObject;
  sourceSystem?: string;
}): SearchDocumentDraft | null {
  const o = params.object;
  const name = o.display_name || o.object_id;
  if (!o.object_type || !o.object_id) return null;

  const attrParts = Object.entries(o.attributes)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `${k}=${String(v)}`)
    .slice(0, 24);

  const facts = [
    `Canonical-Typ: ${o.object_type}`,
    `Objekt-ID: ${o.object_id}`,
    o.source.config_group ? `Exportgruppe: ${o.source.config_group}` : "",
    o.source.source_table ? `Quelltabelle: ${o.source.source_table}` : "",
    ...attrParts.slice(0, 12),
  ].filter(Boolean);

  const entities = [
    { kind: o.object_type, name: o.object_id },
    ...(o.display_name && o.display_name !== o.object_id
      ? [{ kind: "display_name", name: o.display_name }]
      : []),
  ];

  // Surface technical names from attributes for exact matching
  for (const key of [
    "KSCHL",
    "MSGTYP",
    "MESTYP",
    "IDOCTYP",
    "CIMTYP",
    "PGNAM",
    "RONAM",
    "FUNCNAME",
    "PORT",
    "PARNUM",
    "EVCODE",
    "SEGTYP",
    "LOGSYS",
  ]) {
    const val = o.attributes[key];
    if (typeof val === "string" && val.trim()) {
      entities.push({ kind: key.toLowerCase(), name: val.trim().toUpperCase() });
    }
  }

  return {
    source_system: params.sourceSystem ?? o.source.system_id ?? "SAP",
    source_type: "message_idoc_config",
    source_key: o._canonical_key,
    knowledge_unit_type: "message_idoc_object",
    object_type: o.object_type,
    object_name: o.object_id,
    title: `${o.object_type}: ${name}`,
    technical_summary: `${o.object_type} ${o.object_id} (${o.source.source_table})`,
    business_purpose: o.display_name ?? "",
    facts,
    entities,
    tables_read: o.source.source_table ? [o.source.source_table] : [],
    confidence: 0.9,
    analysis_version: "message-idoc-canonical-v1",
    metadata: {
      config_group: o.source.config_group,
      source_table: o.source.source_table,
      raw_file: o.source.raw_file,
      pipeline_type: "MESSAGE_IDOC_CONFIG",
    },
  };
}
