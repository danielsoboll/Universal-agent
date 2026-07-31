import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";
import type {
  CodeTableBinding,
  TableKnowledgeUnit,
  TableRowEvidence,
  TableRuleGroup,
} from "@/lib/tables/types";

function entity(kind: string, name: string) {
  return { kind, name, normalized: name.toUpperCase() };
}

export function draftFromTableProfile(
  unit: TableKnowledgeUnit,
  systemId: string,
): SearchDocumentDraft {
  return {
    source_system: systemId,
    source_type: "table_knowledge_unit",
    source_key: `table_profile:${unit.table_name}`,
    knowledge_unit_type: "table_profile",
    object_type: "TABLE",
    object_name: unit.table_name,
    title: `Tabellenprofil ${unit.table_name}`,
    technical_summary: unit.table_description,
    business_purpose: "",
    facts: unit.facts,
    inferences: unit.inferences,
    entities: [
      entity("table", unit.table_name),
      entity("category", unit.category),
      entity("classification", unit.classification),
      ...unit.key_fields.slice(0, 8).map((k) => entity("key_field", k)),
      ...unit.business_terms.slice(0, 12).map((t) => entity("term", t)),
    ],
    relations: unit.code_references.slice(0, 12).map((c) => ({
      relation_type: "REFERENCED_BY_CODE",
      from_type: "TABLE",
      from_name: unit.table_name,
      to_type: "CODE_UNIT",
      to_name: c,
    })),
    tables_read: [unit.table_name],
    called_methods: unit.code_references
      .map((c) => c.split("|").slice(-1)[0] ?? "")
      .filter(Boolean),
    confidence: unit.classification_confidence,
    metadata: {
      evidence_refs: unit.evidence_refs,
      business_terms: unit.business_terms,
      category: unit.category,
      row_count: unit.row_count,
      knowledge_unit_id: unit.knowledge_unit_id,
      fields: unit.fields.map((f) => f.field_name),
      key_values: unit.key_fields,
      code_references: unit.code_references,
    },
  };
}

export function draftFromTableRuleGroup(
  group: TableRuleGroup,
  systemId: string,
): SearchDocumentDraft {
  return {
    source_system: systemId,
    source_type: "table_rule_group",
    source_key: group.rule_group_id,
    knowledge_unit_type: "table_rule_group",
    object_type: "TABLE_RULE_GROUP",
    object_name: group.table_name,
    subobject_name: group.group_key,
    title: group.title,
    technical_summary: `RuleGroup ${group.grouping_strategy} · ${group.row_count} Zeilen`,
    facts: group.facts,
    inferences: group.cautious_inferences,
    entities: [
      entity("table", group.table_name),
      ...group.controlling_fields.map((f) => entity("field", f)),
      ...group.controlled_values.slice(0, 10).map((v) => entity("value", v)),
    ],
    relations: group.code_references.slice(0, 8).map((c) => ({
      relation_type: "REFERENCED_BY_CODE",
      from_type: "TABLE_RULE_GROUP",
      from_name: group.rule_group_id,
      to_type: "CODE_UNIT",
      to_name: c,
    })),
    tables_read: [group.table_name],
    hardcoded_values: group.controlled_values.slice(0, 12),
    confidence: group.confidence,
    metadata: {
      evidence_refs: group.row_evidence_refs,
      business_terms: [],
      key_values: group.key_range_or_values,
      fields: group.controlling_fields,
      code_references: group.code_references,
      grouping_strategy: group.grouping_strategy,
    },
  };
}

export function draftFromPrimaryTableRow(
  row: TableRowEvidence,
  unit: TableKnowledgeUnit | undefined,
  systemId: string,
): SearchDocumentDraft {
  const valueBits = Object.entries(row.field_values)
    .slice(0, 16)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
  return {
    source_system: systemId,
    source_type: "canonical_table_row",
    source_key: row.row_id,
    knowledge_unit_type: "table_row",
    object_type: "TABLE_ROW",
    object_name: row.table_name,
    subobject_name: row.normalized_key,
    title: `${row.table_name} | ${row.normalized_key}`,
    technical_summary: valueBits.join("; "),
    facts: [
      `Tabelle ${row.table_name}`,
      `Schlüssel ${row.normalized_key}`,
      ...valueBits.map((v) => `Wert ${v}`),
      row.primary_reason ? `Primärgrund ${row.primary_reason}` : "",
    ].filter(Boolean),
    inferences: [],
    entities: [
      entity("table", row.table_name),
      entity("resolved_key", row.normalized_key),
      ...Object.entries(row.field_values)
        .slice(0, 10)
        .map(([k, v]) => entity("value_field", `${k}=${String(v).slice(0, 40)}`)),
    ],
    relations: [
      {
        relation_type: "ROW_OF_TABLE",
        from_type: "TABLE_ROW",
        from_name: row.row_id,
        to_type: "TABLE",
        to_name: row.table_name,
      },
    ],
    tables_read: [row.table_name],
    hardcoded_values: Object.values(row.field_values)
      .map(String)
      .filter((v) => v.length > 0 && v.length <= 40)
      .slice(0, 12),
    confidence: unit ? Math.min(0.9, 0.5 + unit.classification_confidence * 0.4) : 0.5,
    metadata: {
      evidence_refs: [row.source_ref],
      business_terms: unit?.business_terms?.slice(0, 12) ?? [],
      fields: Object.keys(row.field_values),
      key_values: [row.normalized_key],
      code_references: unit?.code_references?.slice(0, 8) ?? [],
      primary_reason: row.primary_reason,
    },
  };
}

export function draftFromCodeTableBinding(
  binding: CodeTableBinding,
  systemId: string,
): SearchDocumentDraft {
  const facts = [
    `${binding.access_kind} auf ${binding.table_name}`,
    `Einheit ${binding.program_or_class} / ${binding.unit_name}`,
    binding.access_mode === "dynamic"
      ? "Dynamischer Tabellenzugriff — noch offen / nicht vollständig aufgelöst"
      : "Statischer Tabellenzugriff",
    binding.key_filters.length
      ? `Filter: ${binding.key_filters.join("; ")}`
      : "",
    binding.resolved_row_ids.length
      ? `Aufgelöste Zeilen: ${binding.resolved_row_ids.length}`
      : "",
  ].filter(Boolean);

  const inferences =
    binding.access_mode === "dynamic"
      ? [
          "Dynamischer Zugriff bleibt unaufgelöst — Zielzeile/RuleGroup ohne zusätzliche Auflösung nicht sicher bestimmbar",
        ]
      : binding.resolved_row_ids.length
        ? [
            "Filterliteral konnte auf kanonische Zeile(n) abgebildet werden (strukturell)",
          ]
        : [];

  return {
    source_system: systemId,
    source_type: "code_table_binding",
    source_key: binding.binding_id,
    knowledge_unit_type:
      binding.access_mode === "dynamic"
        ? "dynamic_table_access"
        : "code_table_interpretation",
    object_type: "CODE_TABLE_BINDING",
    object_name: binding.table_name,
    subobject_name: binding.unit_name,
    title:
      binding.access_mode === "dynamic"
        ? `Dynamischer Zugriff ${binding.unit_name} → ${binding.table_name}`
        : `${binding.unit_name} → ${binding.table_name}`,
    technical_summary: facts.join(". "),
    facts,
    inferences,
    entities: [
      entity("table", binding.table_name),
      entity("object", binding.program_or_class),
      entity("unit", binding.unit_name),
      ...binding.fields.map((f) => entity("field", f)),
    ],
    relations: [
      {
        relation_type: binding.access_kind.startsWith("W")
          ? "WRITES_TABLE"
          : "READS_TABLE",
        from_type: "CODE_UNIT",
        from_name: binding.code_source_key,
        to_type: "TABLE",
        to_name: binding.table_name,
      },
    ],
    tables_read: binding.access_kind.startsWith("W")
      ? []
      : [binding.table_name],
    tables_written: binding.access_kind.startsWith("W")
      ? [binding.table_name]
      : [],
    called_methods: [binding.unit_name],
    confidence: binding.confidence,
    evidence: [
      ...binding.evidence_from_code.map((q) => ({
        statement_type: "fact" as const,
        lines: [{ quote: q }],
      })),
    ],
    metadata: {
      evidence_refs: [
        ...binding.evidence_from_code.map((e) => `CodeEvidence:${e.slice(0, 120)}`),
        ...binding.evidence_from_table,
        `CodeUnit:${binding.code_source_key}`,
      ],
      code_references: [binding.code_source_key],
      fields: binding.fields,
      key_values: binding.key_filters,
      resolved_row_ids: binding.resolved_row_ids,
      resolved_rule_group_ids: binding.resolved_rule_group_ids,
      access_mode: binding.access_mode,
    },
  };
}

/**
 * Lightweight business_rule docs: one per table that has primary rows
 * and is code-referenced customizing/control — aggregates row titles only.
 * Avoids inventing domain rules.
 */
export function draftBusinessRulesFromPrimaryRows(params: {
  units: TableKnowledgeUnit[];
  primaryRows: TableRowEvidence[];
  systemId: string;
}): SearchDocumentDraft[] {
  const byTable = new Map<string, TableRowEvidence[]>();
  for (const r of params.primaryRows) {
    const list = byTable.get(r.table_name) ?? [];
    list.push(r);
    byTable.set(r.table_name, list);
  }
  const drafts: SearchDocumentDraft[] = [];
  for (const unit of params.units) {
    if (!unit.referenced_by_code) continue;
    if (
      unit.classification !== "CUSTOMIZING_CONTROL_TABLE" &&
      unit.category !== "parameter_table" &&
      unit.category !== "control_table"
    ) {
      continue;
    }
    const rows = byTable.get(unit.table_name) ?? [];
    if (rows.length < 2 || rows.length > 40) continue;
    const source_key = `brule_table:${unit.table_name}`;
    drafts.push({
      source_system: params.systemId,
      source_type: "table_business_rule_bundle",
      source_key,
      knowledge_unit_type: "business_rule",
      object_type: "BUSINESS_RULE_BUNDLE",
      object_name: unit.table_name,
      title: `Regelzeilen ${unit.table_name}`,
      technical_summary: `${rows.length} primäre Steuer-/Parameterzeilen`,
      facts: [
        `Tabelle ${unit.table_name}`,
        `Primäre Zeilen: ${rows.length}`,
        ...rows.slice(0, 12).map((r) => `Zeile ${r.normalized_key}`),
      ],
      inferences: [
        "Bündel aus primären Tabellenzeilen — keine zusätzliche fachliche Interpretation",
      ],
      entities: [
        entity("table", unit.table_name),
        ...rows.slice(0, 10).map((r) => entity("resolved_key", r.normalized_key)),
      ],
      relations: unit.code_references.slice(0, 8).map((c) => ({
        relation_type: "REFERENCED_BY_CODE",
        from_type: "BUSINESS_RULE_BUNDLE",
        from_name: source_key,
        to_type: "CODE_UNIT",
        to_name: c,
      })),
      tables_read: [unit.table_name],
      confidence: Math.min(0.8, 0.4 + unit.classification_confidence * 0.4),
      metadata: {
        evidence_refs: rows.map((r) => r.source_ref),
        business_terms: unit.business_terms.slice(0, 12),
        code_references: unit.code_references,
        key_values: rows.map((r) => r.normalized_key),
      },
    });
  }
  return drafts;
}

export function buildAllTableSearchDrafts(params: {
  units: TableKnowledgeUnit[];
  ruleGroups: TableRuleGroup[];
  rows: TableRowEvidence[];
  bindings: CodeTableBinding[];
  systemId: string;
}): SearchDocumentDraft[] {
  const unitByTable = new Map(params.units.map((u) => [u.table_name, u]));
  const primary = params.rows.filter((r) => r.primary_search_document);
  return [
    ...params.units.map((u) => draftFromTableProfile(u, params.systemId)),
    ...params.ruleGroups.map((g) => draftFromTableRuleGroup(g, params.systemId)),
    ...primary.map((r) =>
      draftFromPrimaryTableRow(r, unitByTable.get(r.table_name), params.systemId),
    ),
    ...params.bindings.map((b) => draftFromCodeTableBinding(b, params.systemId)),
    ...draftBusinessRulesFromPrimaryRows({
      units: params.units,
      primaryRows: primary,
      systemId: params.systemId,
    }),
  ];
}
