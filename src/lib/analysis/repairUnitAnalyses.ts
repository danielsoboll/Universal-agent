import { extractAbapArtifacts } from "@/lib/analysis/abapExtract";
import {
  repairEvidenceLines,
  repairEvidencedStatements,
  type EvidenceMismatch,
} from "@/lib/analysis/evidenceRepair";
import { compareExtractions } from "@/lib/analysis/extractionCompare";
import { partitionExternalInterfaces } from "@/lib/analysis/interfaceClassify";
import {
  unitAnalysisRecordSchema,
  type UnitAnalysisRecord,
} from "@/lib/analysis/unitAnalysisSchema";

export type RepairReport = {
  evidence_valid: number;
  evidence_corrigible: number;
  evidence_mismatches: number;
  real_external_interfaces: number;
  discarded_pseudo_interfaces: number;
  extraction_deviations_before: number;
  extraction_deviations_after: number;
  methods_total: number;
  methods_needs_reanalysis: number;
  needs_reanalysis_keys: string[];
};

export type RepairedAnalysisBundle = {
  records: UnitAnalysisRecord[];
  report: RepairReport;
  mismatches: Array<EvidenceMismatch & { source_key: string; method_name: string }>;
};

function asStatementArray(
  value: unknown,
): Array<{ text: string; evidence_lines: Array<{ line: number; quote: string }> }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") {
        return {
          text: item,
          evidence_lines: [] as Array<{ line: number; quote: string }>,
        };
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        return {
          text: String(obj.text ?? ""),
          evidence_lines: Array.isArray(obj.evidence_lines)
            ? (obj.evidence_lines as Array<{ line: number; quote: string }>)
            : [],
        };
      }
      return { text: "", evidence_lines: [] };
    })
    .filter((s) => s.text.trim() !== "");
}

/**
 * Repair/validate one stored analysis against its canonical code_unit source.
 * Does not call OpenAI.
 */
export function repairUnitAnalysisRecord(params: {
  record: Record<string, unknown>;
  sourceCode: string;
}): {
  record: UnitAnalysisRecord;
  needsReanalysis: boolean;
  mismatches: EvidenceMismatch[];
  deviationsBefore: number;
  deviationsAfter: number;
  realInterfaces: number;
  discardedInterfaces: number;
  evidenceValid: number;
  evidenceCorrigible: number;
  evidenceMismatches: number;
} {
  const raw = params.record;
  const factsRepair = repairEvidencedStatements(
    asStatementArray(raw.facts),
    params.sourceCode,
    "fact",
  );
  const inferencesRepair = repairEvidencedStatements(
    asStatementArray(raw.inferences),
    params.sourceCode,
    "inference",
  );
  const topRepair = repairEvidenceLines(
    Array.isArray(raw.evidence_lines)
      ? (raw.evidence_lines as Array<{ line: number; quote: string }>)
      : [],
    params.sourceCode,
    "top",
  );

  const evidenceValid =
    factsRepair.stats.valid +
    inferencesRepair.stats.valid +
    topRepair.stats.valid;
  const evidenceCorrigible =
    factsRepair.stats.corrigible +
    inferencesRepair.stats.corrigible +
    topRepair.stats.corrigible;
  const evidenceMismatches =
    factsRepair.stats.mismatches +
    inferencesRepair.stats.mismatches +
    topRepair.stats.mismatches +
    factsRepair.statementsWithoutEvidence +
    inferencesRepair.statementsWithoutEvidence;

  const mismatches = [
    ...factsRepair.mismatches,
    ...inferencesRepair.mismatches,
    ...topRepair.mismatches,
  ];

  const iface = partitionExternalInterfaces(
    Array.isArray(raw.external_interfaces)
      ? (raw.external_interfaces as string[])
      : [],
  );

  const deterministic = extractAbapArtifacts(params.sourceCode);
  const deviationsBefore = Array.isArray(raw.extraction_deviations)
    ? raw.extraction_deviations.length
    : 0;

  const aiMethods = Array.isArray(raw.called_methods)
    ? (raw.called_methods as string[])
    : [];
  const aiFunctions = Array.isArray(raw.called_functions)
    ? (raw.called_functions as string[]).filter(
        (f) => !/^SELECT(\s+SINGLE)?$/i.test(String(f).trim()),
      )
    : [];

  const extraction_deviations = compareExtractions(
    {
      tables_read: Array.isArray(raw.tables_read)
        ? (raw.tables_read as string[])
        : [],
      tables_written: Array.isArray(raw.tables_written)
        ? (raw.tables_written as string[])
        : [],
      called_functions: aiFunctions,
      called_methods: aiMethods,
    },
    deterministic,
  );

  const needsReanalysis =
    factsRepair.statements.length === 0 ||
    factsRepair.statementsWithoutEvidence > 0 ||
    inferencesRepair.statementsWithoutEvidence > 0;

  const repair_notes: string[] = [];
  if (evidenceCorrigible > 0) {
    repair_notes.push(
      `${evidenceCorrigible} Evidence-Quotes deterministisch aus source_code ersetzt`,
    );
  }
  if (evidenceMismatches > 0) {
    repair_notes.push(`${evidenceMismatches} EVIDENCE_MISMATCH`);
  }
  if (iface.discarded.length > 0) {
    repair_notes.push(
      `${iface.discarded.length} Pseudo-Schnittstellen verworfen`,
    );
  }

  const record = unitAnalysisRecordSchema.parse({
    technical_summary: String(raw.technical_summary ?? ""),
    business_purpose_inferred: String(raw.business_purpose_inferred ?? ""),
    facts: factsRepair.statements,
    inferences: inferencesRepair.statements,
    open_questions: Array.isArray(raw.open_questions) ? raw.open_questions : [],
    tables_read: Array.isArray(raw.tables_read) ? raw.tables_read : [],
    tables_written: Array.isArray(raw.tables_written) ? raw.tables_written : [],
    called_functions: aiFunctions,
    called_methods: aiMethods,
    hardcoded_values: Array.isArray(raw.hardcoded_values)
      ? raw.hardcoded_values
      : [],
    special_cases: Array.isArray(raw.special_cases) ? raw.special_cases : [],
    external_interfaces: iface.real.map((r) => r.name),
    risks: Array.isArray(raw.risks) ? raw.risks : [],
    evidence_lines: topRepair.evidence_lines,
    confidence: Number(raw.confidence ?? 0),
    source_key: String(raw.source_key),
    class_name: String(raw.class_name),
    method_name: String(raw.method_name),
    model: String(raw.model ?? ""),
    prompt_version: String(raw.prompt_version ?? ""),
    content_hash: String(raw.content_hash ?? ""),
    deterministic,
    extraction_deviations,
    external_interfaces_classified: iface.real,
    discarded_interfaces: iface.discarded,
    needs_reanalysis: needsReanalysis,
    repair_notes,
  });

  return {
    record,
    needsReanalysis,
    mismatches,
    deviationsBefore,
    deviationsAfter: extraction_deviations.length,
    realInterfaces: iface.real.length,
    discardedInterfaces: iface.discarded.length,
    evidenceValid,
    evidenceCorrigible,
    evidenceMismatches,
  };
}

export function repairAllUnitAnalyses(params: {
  analyses: Record<string, unknown>[];
  codeUnitsByKey: Map<string, { source_code: string; unit_name?: string }>;
}): RepairedAnalysisBundle {
  const records: UnitAnalysisRecord[] = [];
  const mismatches: Array<
    EvidenceMismatch & { source_key: string; method_name: string }
  > = [];
  const needs: string[] = [];

  let evidence_valid = 0;
  let evidence_corrigible = 0;
  let evidence_mismatches = 0;
  let real_external_interfaces = 0;
  let discarded_pseudo_interfaces = 0;
  let extraction_deviations_before = 0;
  let extraction_deviations_after = 0;

  for (const raw of params.analyses) {
    const key = String(raw.source_key ?? "");
    const unit = params.codeUnitsByKey.get(key);
    if (!unit) {
      needs.push(key);
      mismatches.push({
        code: "EVIDENCE_MISMATCH",
        scope: "top",
        line: null,
        quote: "",
        reason: "code_unit zu source_key nicht gefunden",
        source_key: key,
        method_name: String(raw.method_name ?? ""),
      });
      continue;
    }

    const repaired = repairUnitAnalysisRecord({
      record: raw,
      sourceCode: unit.source_code,
    });

    evidence_valid += repaired.evidenceValid;
    evidence_corrigible += repaired.evidenceCorrigible;
    evidence_mismatches += repaired.evidenceMismatches;
    real_external_interfaces += repaired.realInterfaces;
    discarded_pseudo_interfaces += repaired.discardedInterfaces;
    extraction_deviations_before += repaired.deviationsBefore;
    extraction_deviations_after += repaired.deviationsAfter;

    for (const m of repaired.mismatches) {
      mismatches.push({
        ...m,
        source_key: key,
        method_name: String(raw.method_name ?? unit.unit_name ?? ""),
      });
    }

    records.push(repaired.record);
    if (repaired.needsReanalysis) needs.push(key);
  }

  return {
    records,
    mismatches,
    report: {
      evidence_valid,
      evidence_corrigible,
      evidence_mismatches,
      real_external_interfaces,
      discarded_pseudo_interfaces,
      extraction_deviations_before,
      extraction_deviations_after,
      methods_total: records.length,
      methods_needs_reanalysis: needs.length,
      needs_reanalysis_keys: [...new Set(needs)],
    },
  };
}
