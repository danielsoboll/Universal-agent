import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchEntity, SearchEvidence } from "@/lib/search/searchDocumentSchema";
import type { CodeTableInterpretationInput } from "@/lib/search/adapters/codeTableInterpretation";

function pushEntity(list: SearchEntity[], kind: string, name: string) {
  const n = name.trim();
  if (!n) return;
  list.push({
    kind,
    name: n,
    normalized: normalizeSearchToken(n).toUpperCase(),
  });
}

/**
 * Group interpretations by business_rule_id into one SearchDocument.
 * source_key = business_rule_id (does not alter interpretation source_keys).
 */
export function draftFromBusinessRule(params: {
  business_rule_id: string;
  members: CodeTableInterpretationInput[];
  sourceSystem: string;
}): SearchDocumentDraft | null {
  const members = params.members;
  if (members.length === 0) return null;
  const primary = members[0]!;
  const methods = [...new Set(members.map((m) => m.method_name))];
  const accessIds = [...new Set(members.map((m) => m.access_id))];
  const classes = [...new Set(members.map((m) => m.class_name))];

  const facts = [
    `Tabelle ${primary.table_name}`,
    `Aufgelöster Schlüssel ${primary.resolved_key}`,
    ...Object.entries(primary.resolved_values ?? {}).map(
      ([k, v]) => `Tabellenwert ${k}=${v}`,
    ),
    `Betroffene Methoden: ${methods.join(", ")}`,
    `Technische Zugriffe: ${accessIds.length}`,
  ];

  const inferences = [
    primary.business_rule_inferred,
    ...members.flatMap((m) => (m.inferences ?? []).map((i) => i.text)),
  ].filter(Boolean);
  const uniqInf = [...new Set(inferences)];

  const entities: SearchEntity[] = [];
  for (const c of classes) pushEntity(entities, "object", c);
  for (const m of methods) pushEntity(entities, "unit", m);
  pushEntity(entities, "table", primary.table_name);
  pushEntity(entities, "resolved_key", primary.resolved_key);
  pushEntity(entities, "business_rule", params.business_rule_id);

  const evidence: SearchEvidence[] = [
    {
      statement_type: "inference",
      text: primary.business_rule_inferred,
      lines: [],
    },
    ...members.flatMap((m) =>
      (m.evidence_from_code ?? []).slice(0, 4).map((q) => {
        const match = /^L(\d+)\|(.*)$/.exec(q);
        return {
          statement_type: "general" as const,
          lines: match
            ? [{ line: Number(match[1]), quote: match[2] }]
            : [{ quote: q }],
        };
      }),
    ),
  ];

  const unresolved = [
    ...new Set(members.flatMap((m) => m.unresolved_points ?? [])),
  ];

  const evidence_refs = [
    ...members.map((m) => `CodeTableInterpretation:${m.source_key}`),
    `CanonicalTableRow:${primary.table_row_source_key}`,
    ...accessIds.map((id) => `Access:${id}`),
  ];

  const avgConf =
    members.reduce((s, m) => s + (m.confidence ?? 0), 0) / members.length;

  return {
    source_system: params.sourceSystem,
    source_type: "business_rule",
    source_key: params.business_rule_id,
    knowledge_unit_type: "business_rule",
    object_type: "BUSINESS_RULE",
    object_name: primary.table_name,
    subobject_name: primary.resolved_key,
    title: `Geschäftsregel ${primary.table_name} ${primary.resolved_key}`,
    technical_summary: primary.technical_interpretation,
    business_purpose: primary.business_rule_inferred,
    facts,
    inferences: uniqInf,
    entities,
    relations: [
      ...accessIds.map((id) => ({
        relation_type: "GROUPS_ACCESS",
        from_type: "BUSINESS_RULE",
        from_name: params.business_rule_id,
        to_type: "ACCESS",
        to_name: id,
      })),
      ...methods.map((m) => ({
        relation_type: "APPLIES_IN_METHOD",
        from_type: "BUSINESS_RULE",
        from_name: params.business_rule_id,
        to_type: "METHOD",
        to_name: m,
      })),
      {
        relation_type: "USES_TABLE_ROW",
        from_type: "BUSINESS_RULE",
        from_name: params.business_rule_id,
        to_type: "TABLE_ROW",
        to_name: primary.table_row_source_key,
      },
    ],
    tables_read: [primary.table_name],
    called_methods: methods,
    hardcoded_values: [
      primary.resolved_key,
      ...Object.entries(primary.resolved_values ?? {}).map(
        ([k, v]) => `${k}=${v}`,
      ),
    ],
    evidence,
    confidence: avgConf,
    analysis_version: primary.prompt_version ?? "",
    metadata: {
      business_rule_id: params.business_rule_id,
      access_ids: accessIds,
      member_source_keys: members.map((m) => m.source_key),
      resolved_key: primary.resolved_key,
      resolved_values: primary.resolved_values,
      unresolved_points: unresolved,
      evidence_refs,
    },
  };
}
