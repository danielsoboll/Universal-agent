import type { UnitAnalysisRecord } from "@/lib/analysis/unitAnalysisSchema";
import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";
import type {
  SearchEntity,
  SearchEvidence,
  SearchRelation,
} from "@/lib/search/searchDocumentSchema";
import { normalizeSearchToken } from "@/lib/search/buildSearchText";

/** Minimal canonical code-unit fields needed for indexing (source-agnostic shape). */
export type CodeUnitRef = {
  source_key: string;
  system_id?: string;
  object_type?: string;
  object_name?: string;
  unit_type?: string;
  unit_name?: string;
  include_name?: string;
  language?: string;
  line_count?: number;
  content_hash?: string;
};

function statementTexts(
  entries: Array<{ text?: string } | string> | undefined,
): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => {
      if (typeof e === "string") return e.trim();
      if (e && typeof e === "object" && typeof e.text === "string") {
        return e.text.trim();
      }
      return "";
    })
    .filter(Boolean);
}

function buildEvidence(analysis: UnitAnalysisRecord): SearchEvidence[] {
  const out: SearchEvidence[] = [];

  for (const fact of analysis.facts ?? []) {
    out.push({
      statement_type: "fact",
      text: fact.text,
      lines: (fact.evidence_lines ?? []).map((l) => ({
        line: l.line,
        quote: l.quote,
      })),
    });
  }
  for (const inf of analysis.inferences ?? []) {
    out.push({
      statement_type: "inference",
      text: inf.text,
      lines: (inf.evidence_lines ?? []).map((l) => ({
        line: l.line,
        quote: l.quote,
      })),
    });
  }
  for (const line of analysis.evidence_lines ?? []) {
    out.push({
      statement_type: "general",
      lines: [{ line: line.line, quote: line.quote }],
    });
  }
  return out;
}

function buildEntities(params: {
  analysis: UnitAnalysisRecord;
  unit?: CodeUnitRef | null;
}): SearchEntity[] {
  const entities: SearchEntity[] = [];
  const push = (kind: string, name: string) => {
    const n = name.trim();
    if (!n) return;
    entities.push({
      kind,
      name: n,
      normalized: normalizeSearchToken(n).toUpperCase(),
    });
  };

  const a = params.analysis;
  const u = params.unit;
  if (u?.object_name) push("object", u.object_name);
  if (u?.unit_name) push("unit", u.unit_name);
  if (a.class_name) push("object", a.class_name);
  if (a.method_name) push("unit", a.method_name);

  for (const t of a.tables_read ?? []) push("table_read", t);
  for (const t of a.tables_written ?? []) push("table_written", t);
  for (const m of a.called_methods ?? []) push("method", m);
  for (const f of a.called_functions ?? []) push("function", f);
  for (const m of a.macro_calls ?? []) push("macro", m.name);
  for (const i of a.external_interfaces ?? []) push("interface", i);

  // Deduplicate by kind|normalized
  const seen = new Set<string>();
  return entities.filter((e) => {
    const k = `${e.kind}|${e.normalized ?? e.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildRelations(analysis: UnitAnalysisRecord): SearchRelation[] {
  return (analysis.relations ?? []).map((r) => ({
    relation_type: r.relation_type,
    from_type: r.from_type,
    from_name: r.from_name,
    to_type: r.to_type,
    to_name: r.to_name,
  }));
}

/**
 * Adapter: code-unit analysis → generic SearchDocument draft.
 * SAP/ABAP is the first concrete knowledge-unit type — naming stays generic.
 */
export function draftFromCodeUnitAnalysis(params: {
  analysis: UnitAnalysisRecord;
  unit?: CodeUnitRef | null;
  sourceSystem?: string;
}): SearchDocumentDraft {
  const a = params.analysis;
  const u = params.unit;
  const objectName = (u?.object_name || a.class_name || "").trim();
  const subobjectName = (u?.unit_name || a.method_name || "").trim();
  const objectType = (u?.object_type || "CODE_OBJECT").trim();
  const unitType = (u?.unit_type || "UNIT").trim();

  const title = [objectType, objectName, unitType, subobjectName]
    .filter(Boolean)
    .join(" / ");

  const source_system =
    params.sourceSystem?.trim() ||
    u?.system_id?.trim() ||
    a.source_key.split("|")[0] ||
    "unknown";

  return {
    source_system,
    source_type: "code_unit_analysis",
    source_key: a.source_key,
    knowledge_unit_type: "code_unit",
    object_type: objectType,
    object_name: objectName,
    subobject_name: subobjectName,
    title,
    technical_summary: a.technical_summary ?? "",
    business_purpose: a.business_purpose_inferred ?? "",
    facts: statementTexts(a.facts),
    inferences: statementTexts(a.inferences),
    entities: buildEntities({ analysis: a, unit: u }),
    relations: buildRelations(a),
    tables_read: a.tables_read ?? [],
    tables_written: a.tables_written ?? [],
    called_methods: a.called_methods ?? [],
    called_functions: a.called_functions ?? [],
    macro_calls: (a.macro_calls ?? []).map((m) => m.name),
    hardcoded_values: a.hardcoded_values ?? [],
    external_interfaces: a.external_interfaces ?? [],
    risks: a.risks ?? [],
    evidence: buildEvidence(a),
    confidence: a.confidence,
    analysis_version: a.prompt_version ?? "",
    metadata: {
      unit_type: unitType,
      include_name: u?.include_name ?? null,
      language: u?.language ?? null,
      line_count: u?.line_count ?? null,
      analysis_model: a.model ?? null,
      analysis_content_hash: a.content_hash ?? null,
      unit_content_hash: u?.content_hash ?? null,
    },
  };
}
