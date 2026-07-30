import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchEntity, SearchEvidence } from "@/lib/search/searchDocumentSchema";

export type CodeTableInterpretationInput = {
  source_key: string;
  code_source_key: string;
  class_name: string;
  method_name: string;
  table_name: string;
  table_row_source_key: string;
  resolved_key: string;
  resolved_values: Record<string, string>;
  access_id: string;
  business_rule_id: string;
  technical_interpretation: string;
  business_rule_inferred: string;
  facts?: Array<{ text: string; evidence?: string[] }>;
  inferences?: Array<{ text: string; evidence?: string[] }>;
  evidence_from_code?: string[];
  evidence_from_table?: string[];
  unresolved_points?: string[];
  confidence?: number;
  prompt_version?: string;
  content_hash?: string;
};

function pushEntity(list: SearchEntity[], kind: string, name: string) {
  const n = name.trim();
  if (!n) return;
  list.push({
    kind,
    name: n,
    normalized: normalizeSearchToken(n).toUpperCase(),
  });
}

export function draftFromCodeTableInterpretation(params: {
  record: CodeTableInterpretationInput;
  sourceSystem: string;
}): SearchDocumentDraft {
  const r = params.record;
  const facts = (r.facts ?? []).map((f) => f.text.trim()).filter(Boolean);
  const inferences = (r.inferences ?? [])
    .map((f) => f.text.trim())
    .filter(Boolean);
  if (
    r.business_rule_inferred &&
    !inferences.includes(r.business_rule_inferred)
  ) {
    inferences.push(r.business_rule_inferred);
  }

  const entities: SearchEntity[] = [];
  pushEntity(entities, "object", r.class_name);
  pushEntity(entities, "unit", r.method_name);
  pushEntity(entities, "table", r.table_name);
  pushEntity(entities, "resolved_key", r.resolved_key);
  for (const [k, v] of Object.entries(r.resolved_values ?? {})) {
    pushEntity(entities, "table_field", `${k}=${v}`);
  }

  const evidence: SearchEvidence[] = [];
  for (const f of r.facts ?? []) {
    evidence.push({
      statement_type: "fact",
      text: f.text,
      lines: (f.evidence ?? []).map((q) => ({ quote: q })),
    });
  }
  for (const inf of r.inferences ?? []) {
    evidence.push({
      statement_type: "inference",
      text: inf.text,
      lines: (inf.evidence ?? []).map((q) => ({ quote: q })),
    });
  }
  for (const q of r.evidence_from_code ?? []) {
    const m = /^L(\d+)\|(.*)$/.exec(q);
    evidence.push({
      statement_type: "general",
      lines: m
        ? [{ line: Number(m[1]), quote: m[2] }]
        : [{ quote: q }],
    });
  }

  const evidence_refs = [
    ...(r.evidence_from_code ?? []),
    ...(r.evidence_from_table ?? []),
    `CanonicalTableRow:${r.table_row_source_key}`,
    `CodeUnit:${r.code_source_key}`,
  ];

  const valueBits = Object.entries(r.resolved_values ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  return {
    source_system: params.sourceSystem,
    source_type: "code_table_interpretation",
    source_key: r.source_key,
    knowledge_unit_type: "code_table_interpretation",
    object_type: "METHOD",
    object_name: r.class_name,
    subobject_name: r.method_name,
    title: `${r.method_name} → ${r.table_name} (${r.resolved_key})`,
    technical_summary: r.technical_interpretation,
    business_purpose: r.business_rule_inferred,
    facts,
    inferences,
    entities,
    relations: [
      {
        relation_type: "INTERPRETS_ACCESS",
        from_type: "CODE_UNIT",
        from_name: r.code_source_key,
        to_type: "TABLE_ROW",
        to_name: r.table_row_source_key,
      },
      {
        relation_type: "BELONGS_TO_BUSINESS_RULE",
        from_type: "ACCESS",
        from_name: r.access_id,
        to_type: "BUSINESS_RULE",
        to_name: r.business_rule_id,
      },
      {
        relation_type: "READS_TABLE",
        from_type: "CODE_UNIT",
        from_name: r.method_name,
        to_type: "TABLE",
        to_name: r.table_name,
      },
    ],
    tables_read: [r.table_name],
    called_methods: [r.method_name],
    hardcoded_values: [r.resolved_key, valueBits].filter(Boolean),
    evidence,
    confidence: r.confidence ?? null,
    analysis_version: r.prompt_version ?? "",
    metadata: {
      access_id: r.access_id,
      business_rule_id: r.business_rule_id,
      table_row_source_key: r.table_row_source_key,
      resolved_key: r.resolved_key,
      resolved_values: r.resolved_values,
      unresolved_points: r.unresolved_points ?? [],
      evidence_refs,
      analysis_content_hash: r.content_hash ?? null,
    },
  };
}
