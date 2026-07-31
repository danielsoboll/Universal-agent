import { createHash } from "crypto";
import { draftFromBusinessRule } from "@/lib/search/adapters/businessRule";
import {
  draftFromCanonicalTableRow,
  type CanonicalTableRowInput,
} from "@/lib/search/adapters/canonicalTableRow";
import {
  draftFromCodeTableInterpretation,
  type CodeTableInterpretationInput,
} from "@/lib/search/adapters/codeTableInterpretation";
import {
  draftFromCodeUnitAnalysis,
  type CodeUnitRef,
} from "@/lib/search/adapters/codeUnitAnalysis";
import {
  draftFromControlTableAnalysis,
  type ControlTableAnalysisInput,
} from "@/lib/search/adapters/controlTableAnalysis";
import {
  draftFromDynamicTableAccess,
  type DynamicTableAccessInput,
} from "@/lib/search/adapters/dynamicTableAccess";
import type { SearchDocumentDraft } from "@/lib/search/buildSearchDocuments";
import type { UnitAnalysisRecord } from "@/lib/analysis/unitAnalysisSchema";

export type HybridSearchCorpusInput = {
  sourceSystem: string;
  codeUnitAnalyses: UnitAnalysisRecord[];
  codeUnits: Map<string, CodeUnitRef>;
  tableAnalyses: ControlTableAnalysisInput[];
  interpretations: CodeTableInterpretationInput[];
  tableRows: CanonicalTableRowInput[];
  dynamicAccesses: DynamicTableAccessInput[];
};

/**
 * Keep ControlTableRows that are already grounded in analyses/interpretations.
 * All other canonical rows are redundant noise for a retrieval MVP.
 * Purely structural — no domain/customer special cases.
 */
export function selectNonRedundantTableRows(params: {
  tableRows: CanonicalTableRowInput[];
  tableAnalyses: ControlTableAnalysisInput[];
  interpretations: CodeTableInterpretationInput[];
}): CanonicalTableRowInput[] {
  const referencedKeys = new Set(
    params.interpretations
      .map((i) => i.table_row_source_key)
      .filter((k): k is string => Boolean(k)),
  );
  const analyzedTables = new Set(
    [
      ...params.tableAnalyses.map((a) => a.table_name).filter(Boolean),
      ...params.interpretations.map((i) => i.table_name).filter(Boolean),
    ].map(String),
  );

  return params.tableRows.filter((row) => {
    if (referencedKeys.has(row.source_key)) return true;
    if (analyzedTables.has(row.table_name)) return true;
    return false;
  });
}

export function buildHybridSearchDrafts(
  input: HybridSearchCorpusInput,
): SearchDocumentDraft[] {
  const drafts: SearchDocumentDraft[] = [];

  for (const analysis of input.codeUnitAnalyses) {
    drafts.push(
      draftFromCodeUnitAnalysis({
        analysis,
        unit: input.codeUnits.get(analysis.source_key) ?? null,
        sourceSystem: input.sourceSystem,
      }),
    );
  }

  for (const analysis of input.tableAnalyses) {
    drafts.push(
      draftFromControlTableAnalysis({
        analysis,
        sourceSystem: input.sourceSystem,
      }),
    );
  }

  for (const record of input.interpretations) {
    drafts.push(
      draftFromCodeTableInterpretation({
        record,
        sourceSystem: input.sourceSystem,
      }),
    );
  }

  const byRule = new Map<string, CodeTableInterpretationInput[]>();
  for (const record of input.interpretations) {
    const id = record.business_rule_id;
    if (!id) continue;
    const list = byRule.get(id) ?? [];
    list.push(record);
    byRule.set(id, list);
  }
  for (const [business_rule_id, members] of byRule) {
    const draft = draftFromBusinessRule({
      business_rule_id,
      members,
      sourceSystem: input.sourceSystem,
    });
    if (draft) drafts.push(draft);
  }

  const rows = selectNonRedundantTableRows({
    tableRows: input.tableRows,
    tableAnalyses: input.tableAnalyses,
    interpretations: input.interpretations,
  });
  for (const row of rows) {
    drafts.push(
      draftFromCanonicalTableRow({
        row,
        sourceSystem: input.sourceSystem,
      }),
    );
  }

  for (const access of input.dynamicAccesses) {
    const sourceKey = createHash("sha256")
      .update(
        [
          access.code_source_key,
          access.table_name,
          access.access_kind ?? "",
          String(access.line_start ?? ""),
          (access.evidence ?? [])[0] ?? "",
        ].join("||"),
        "utf8",
      )
      .digest("hex")
      .slice(0, 24);
    drafts.push(
      draftFromDynamicTableAccess({
        access,
        sourceSystem: input.sourceSystem,
        sourceKey: `dynamic:${sourceKey}`,
      }),
    );
  }

  return drafts;
}
