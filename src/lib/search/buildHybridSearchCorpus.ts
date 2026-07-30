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

  for (const row of input.tableRows) {
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
