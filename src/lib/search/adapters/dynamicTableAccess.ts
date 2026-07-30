import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchEntity } from "@/lib/search/searchDocumentSchema";

export type DynamicTableAccessInput = {
  code_source_key: string;
  method_name?: string;
  table_name: string;
  table_expression?: string;
  variable_source?: Array<{ field: string; variable: string }>;
  known_value_flow?: Array<{ field: string; literal: string | null }>;
  unresolved_reason: string;
  evidence?: string[];
  recommended_resolution_strategy?: string;
  access_kind?: string;
  line_start?: number;
  into_target?: string | null;
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

export function draftFromDynamicTableAccess(params: {
  access: DynamicTableAccessInput;
  sourceSystem: string;
  /** Stable id when source_key not present on record. */
  sourceKey: string;
}): SearchDocumentDraft {
  const a = params.access;
  const vars = (a.variable_source ?? [])
    .map((v) => `${v.field}=${v.variable}`)
    .join(", ");
  const method =
    a.method_name ||
    a.code_source_key.split("|").slice(-1)[0] ||
    a.code_source_key;

  const entities: SearchEntity[] = [];
  pushEntity(entities, "table", a.table_name);
  pushEntity(entities, "unit", method);
  for (const v of a.variable_source ?? []) {
    pushEntity(entities, "variable", v.variable);
    pushEntity(entities, "field", v.field);
  }

  const facts = [
    `Dynamischer Zugriff auf ${a.table_name}`,
    `noch nicht auflösbar unresolved dynamisch`,
    a.access_kind ? `Zugriffsart ${a.access_kind}` : "",
    vars ? `Unresolved Variablen: ${vars}` : "",
    a.unresolved_reason,
  ].filter(Boolean);

  return {
    source_system: params.sourceSystem,
    source_type: "dynamic_table_access",
    source_key: params.sourceKey,
    knowledge_unit_type: "dynamic_table_access",
    object_type: "DYNAMIC_ACCESS",
    object_name: a.table_name,
    subobject_name: method,
    title: `Dynamisch: ${method} → ${a.table_name}`,
    technical_summary: a.unresolved_reason,
    business_purpose: "",
    facts,
    inferences: a.recommended_resolution_strategy
      ? [`INFERENCE-Kandidat: ${a.recommended_resolution_strategy}`]
      : [],
    entities,
    relations: [
      {
        relation_type: "DYNAMIC_ACCESS_TO_TABLE",
        from_type: "CODE_UNIT",
        from_name: a.code_source_key,
        to_type: "TABLE",
        to_name: a.table_name,
      },
      {
        relation_type: "UNRESOLVED_WHERE",
        from_type: "CODE_UNIT",
        from_name: method,
        to_type: "TABLE",
        to_name: a.table_name,
      },
    ],
    tables_read: a.access_kind === "WRITE" ? [] : [a.table_name],
    tables_written: a.access_kind === "WRITE" ? [a.table_name] : [],
    called_methods: [method],
    evidence: (a.evidence ?? []).map((q) => ({
      statement_type: "fact" as const,
      text: "Evidence aus Code-Zugriff",
      lines: [{ quote: q.slice(0, 240), line: a.line_start }],
    })),
    confidence: 0.4,
    analysis_version: "",
    metadata: {
      code_source_key: a.code_source_key,
      variable_source: a.variable_source ?? [],
      known_value_flow: a.known_value_flow ?? [],
      recommended_resolution_strategy:
        a.recommended_resolution_strategy ?? null,
      evidence_refs: (a.evidence ?? []).map(
        (e, i) => `dynamic_evidence:${i}:${e.slice(0, 120)}`,
      ),
      unresolved_reason: a.unresolved_reason,
    },
  };
}
