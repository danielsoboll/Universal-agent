import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";
import type { SearchEntity, SearchEvidence } from "@/lib/search/searchDocumentSchema";

export type ControlTableAnalysisInput = {
  source_key: string;
  table_name: string;
  technical_purpose?: string;
  business_purpose_inferred?: string;
  likely_table_role?: string;
  key_semantics?: string[];
  value_semantics?: string[];
  parameters?: string[];
  mappings?: string[];
  status_codes?: string[];
  system_references?: string[];
  special_cases?: string[];
  facts?: Array<{ text: string; evidence?: string[] } | string>;
  inferences?: Array<{ text: string; evidence?: string[] } | string>;
  risks?: string[];
  unresolved_points?: string[];
  evidence?: string[];
  confidence?: number;
  prompt_version?: string;
  content_hash?: string;
  selection_reason?: string;
  model?: string;
};

function texts(
  entries: Array<{ text: string; evidence?: string[] } | string> | undefined,
): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => (typeof e === "string" ? e.trim() : e.text?.trim() ?? ""))
    .filter(Boolean);
}

function pushEntity(list: SearchEntity[], kind: string, name: string) {
  const n = name.trim();
  if (!n) return;
  list.push({
    kind,
    name: n,
    normalized: normalizeSearchToken(n).toUpperCase(),
  });
}

export function draftFromControlTableAnalysis(params: {
  analysis: ControlTableAnalysisInput;
  sourceSystem: string;
}): SearchDocumentDraft {
  const a = params.analysis;
  const facts = texts(a.facts);
  const inferences = texts(a.inferences);
  const entities: SearchEntity[] = [];
  pushEntity(entities, "table", a.table_name);
  for (const c of a.status_codes ?? []) pushEntity(entities, "status_code", c);
  for (const p of a.parameters ?? []) pushEntity(entities, "parameter", p);

  const evidence: SearchEvidence[] = [];
  for (const f of a.facts ?? []) {
    if (typeof f === "string") {
      evidence.push({ statement_type: "fact", text: f, lines: [] });
    } else {
      evidence.push({
        statement_type: "fact",
        text: f.text,
        lines: (f.evidence ?? []).map((q) => ({ quote: q })),
      });
    }
  }
  for (const inf of a.inferences ?? []) {
    if (typeof inf === "string") {
      evidence.push({ statement_type: "inference", text: inf, lines: [] });
    } else {
      evidence.push({
        statement_type: "inference",
        text: inf.text,
        lines: (inf.evidence ?? []).map((q) => ({ quote: q })),
      });
    }
  }

  const evidence_refs = [
    `CanonicalTableDefinition:${a.source_key}`,
    ...(a.evidence ?? []).slice(0, 20),
  ];

  return {
    source_system: params.sourceSystem,
    source_type: "control_table_analysis",
    source_key: a.source_key,
    knowledge_unit_type: "control_table",
    object_type: "TABLE",
    object_name: a.table_name,
    subobject_name: "",
    title: `Steuertabelle ${a.table_name}`,
    technical_summary: a.technical_purpose ?? "",
    business_purpose: a.business_purpose_inferred ?? "",
    facts,
    inferences,
    entities,
    relations: [
      {
        relation_type: "ANALYZES_TABLE",
        from_type: "ANALYSIS",
        from_name: a.source_key,
        to_type: "TABLE",
        to_name: a.table_name,
      },
    ],
    tables_read: [a.table_name],
    risks: a.risks ?? [],
    evidence,
    confidence: a.confidence ?? null,
    analysis_version: a.prompt_version ?? "",
    hardcoded_values: [
      ...(a.status_codes ?? []),
      ...(a.key_semantics ?? []).slice(0, 10),
    ],
    metadata: {
      likely_table_role: a.likely_table_role ?? null,
      selection_reason: a.selection_reason ?? null,
      unresolved_points: a.unresolved_points ?? [],
      evidence_refs,
      analysis_content_hash: a.content_hash ?? null,
    },
  };
}
