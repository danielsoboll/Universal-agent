/**
 * Adapter: canonical master_field_definition → SearchDocument draft.
 * Especially for Z/Y/ZZ/Append fields that must be searchable as MASTER_DATA_BUSINESS_FIELD.
 */
import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";

export type MasterFieldDefinitionInput = {
  table_name: string;
  field_name: string;
  description?: string;
  /** Alias for description when present in source. */
  field_text?: string;
  data_element?: string;
  data_element_text?: string;
  domain?: string;
  domain_text?: string;
  data_type?: string;
  length?: number | string;
  position?: number;
  system_id?: string;
  profile?: string;
  key?: boolean;
  included_in_content?: boolean;
  _is_z_field?: boolean;
  _is_append_include?: boolean;
  _source_file?: string;
  _canonical_key?: string;
};

export function isZOrAppendField(fieldName: string): boolean {
  const n = fieldName.trim().toUpperCase();
  return (
    /^(Z|Y|ZZ|YY)/.test(n) ||
    n.includes("_Z") ||
    n.startsWith("/") ||
    n.startsWith(".INCLU")
  );
}

export function draftFromMasterFieldDefinition(params: {
  field: MasterFieldDefinitionInput;
  sourceSystem?: string;
}): SearchDocumentDraft | null {
  const f = params.field;
  const table = String(f.table_name ?? "").trim().toUpperCase();
  const field = String(f.field_name ?? "").trim().toUpperCase();
  if (!table || !field) return null;

  const fieldText = String(f.field_text ?? f.description ?? "").trim();
  const description = fieldText;
  const dataElement = String(f.data_element ?? "").trim();
  const dataElementText = String(f.data_element_text ?? "").trim();
  const domain = String(f.domain ?? "").trim();
  const domainText = String(f.domain_text ?? "").trim();
  const dataType = String(f.data_type ?? "").trim();
  const length = f.length != null ? String(f.length) : "";
  const isZ =
    f._is_z_field === true ||
    isZOrAppendField(field) ||
    isZOrAppendField(dataElement);
  const appendInfo = f._is_append_include
    ? "Append-/Include-Feld"
    : null;

  const title = `${table}-${field}`;
  const technical_name = title;
  const source_system =
    params.sourceSystem?.trim() ||
    String(f.system_id ?? "").trim() ||
    "unknown";
  const source_path =
    String(f._source_file ?? "").trim() ||
    `canonical/master-data/.../${table}/structure.jsonl`;

  const search_text = [
    technical_name,
    table,
    field,
    fieldText,
    dataElement,
    dataElementText,
    domain,
    domainText,
    appendInfo,
    source_path,
  ]
    .filter(Boolean)
    .join(" · ");

  const facts = [
    fieldText ? `Feldtext: ${fieldText}` : null,
    dataElement ? `Datenelement: ${dataElement}` : null,
    dataElementText ? `Datenelement-Text: ${dataElementText}` : null,
    domain ? `Domäne: ${domain}` : null,
    domainText ? `Domänen-Text: ${domainText}` : null,
    dataType ? `Datentyp: ${dataType}${length ? `(${length})` : ""}` : null,
    appendInfo,
    isZ ? "Custom Z/Y/Append-Feld" : null,
    `Technischer Name: ${technical_name}`,
    `source_path: ${source_path}`,
  ].filter(Boolean) as string[];

  return {
    source_system,
    source_type: "master_field_definition",
    source_key: `${source_system}|MASTER_FIELD|${table}|${field}`,
    knowledge_unit_type: "master_field",
    object_type: "TABLE_FIELD",
    object_name: table,
    subobject_name: field,
    title,
    technical_summary: [
      `Stammdatenfeld ${technical_name}`,
      fieldText || null,
      dataElement ? `DE=${dataElement}` : null,
      dataElementText || null,
      domain ? `DOM=${domain}` : null,
      domainText || null,
    ]
      .filter(Boolean)
      .join(" · "),
    business_purpose: fieldText || undefined,
    facts,
    inferences: [],
    entities: [
      { kind: "table", name: table, normalized: table },
      { kind: "field", name: field, normalized: field },
      ...(dataElement
        ? [
            {
              kind: "data_element",
              name: dataElement,
              normalized: dataElement.toUpperCase(),
            },
          ]
        : []),
      ...(domain
        ? [{ kind: "domain", name: domain, normalized: domain.toUpperCase() }]
        : []),
    ],
    relations: [],
    tables_read: [table],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    macro_calls: [],
    hardcoded_values: [],
    external_interfaces: [],
    risks: [],
    evidence: fieldText
      ? [
          {
            statement_type: "fact" as const,
            text: `${technical_name}: ${fieldText}`,
            lines: [],
          },
        ]
      : [],
    confidence: isZ ? 0.95 : 0.75,
    analysis_version: "master-field-v2",
    metadata: {
      table_name: table,
      field_name: field,
      technical_name,
      field_text: fieldText,
      description: fieldText,
      data_element: dataElement,
      data_element_text: dataElementText,
      domain,
      domain_text: domainText,
      append_include: Boolean(f._is_append_include),
      data_type: dataType,
      length,
      position: f.position ?? null,
      profile: f.profile ?? null,
      is_z_field: isZ,
      is_append_include: Boolean(f._is_append_include),
      canonical_key: f._canonical_key ?? null,
      source_file: f._source_file ?? null,
      source_path,
      search_text,
      evidence_class: isZ
        ? "MASTER_DATA_BUSINESS_FIELD"
        : "MASTER_DATA_FIELD",
    },
  };
}
