/**
 * HARDCODED_VALUE_INVENTORY resolver — stream code units, extract MATNR-bound literals.
 */
import { BOUND_DATA_PROJECT_KEY } from "@/lib/localData/boundProject";
import {
  loadClassAnalysesMap,
  loadCodeUnitIndex,
} from "@/lib/knowledge/graphSelector/loadGraph";
import { classifyHardcodedValueIntent } from "./classifyHardcodedValueIntent";
import { scanUnitForMaterialHardcodes } from "./scanMaterialLiterals";
import { buildHardcodedValueAnswerView } from "./formatHardcodedValueAnswer";
import { enrichHardcodedValueAnswer } from "./enrichHardcodedValueAnswer";
import {
  analysisHintToRationale,
  extractAnalysisHint,
} from "./analysisHints";
import type {
  HardcodedOccurrence,
  HardcodedValueInventoryResult,
  HardcodedValueQueryClassification,
} from "./types";

function processFromObjectName(object_name: string): string | null {
  const n = object_name.toUpperCase();
  if (/ATP|PRUEF|PRÜF/.test(n)) return "ATP-/Verfügbarkeitsprüfung";
  if (/EDI|IDOC|ORDERS|DESADV|INVOIC/.test(n)) return "EDI-/Belegverarbeitung";
  if (/LAGER|VLAGER|BESTAND/.test(n)) return "Lager-/Bestandsprozess";
  if (/FAKTUR|BILLING|INVOICE/.test(n)) return "Fakturierung";
  if (/LIEF|DELIV|SHIP/.test(n)) return "Lieferprozess";
  return null;
}

function emptyResult(
  classification: HardcodedValueQueryClassification,
  started: number,
): HardcodedValueInventoryResult {
  return {
    used: false,
    classification,
    answer_view: null,
    summary_sentence: "",
    diagnostics: {
      classification,
      units_scanned: 0,
      units_with_matnr_context: 0,
      literals_seen: 0,
      accepted_candidates: 0,
      excluded_candidates: 0,
      unique_materials: [],
      duration_ms: Date.now() - started,
    },
    sources: [],
    duration_ms: Date.now() - started,
  };
}

export async function runHardcodedValueInventoryResolver(params: {
  question: string;
  projectKey?: string;
}): Promise<HardcodedValueInventoryResult> {
  const started = Date.now();
  const classification = classifyHardcodedValueIntent(params.question);
  if (classification.intent !== "HARDCODED_VALUE_INVENTORY") {
    return emptyResult(classification, started);
  }

  // Currently fully implemented for MATERIAL_NUMBER; other types fail closed.
  if (classification.requested_value_type !== "MATERIAL_NUMBER") {
    const summary =
      "Für diesen Werttyp ist der Hardcoded-Value-Resolver noch nicht vollständig angebunden; es wurden keine Materialnummern-Fundstellen ausgewertet.";
    return {
      used: true,
      classification,
      summary_sentence: summary,
      answer_view: {
        summary: {
          text: summary,
          unique_material_count: 0,
          active_occurrence_count: 0,
          comment_only_count: 0,
          excluded_literal_count: 0,
          units_scanned: 0,
          units_with_matnr_context: 0,
        },
        materials: [],
        multi_use: [],
        comment_or_unclear: [],
        excluded_sample: [],
        missing_information: [
          `requested_value_type=${classification.requested_value_type} — nur MATERIAL_NUMBER ist implementiert.`,
        ],
        sources: [],
      },
      diagnostics: {
        classification,
        units_scanned: 0,
        units_with_matnr_context: 0,
        literals_seen: 0,
        accepted_candidates: 0,
        excluded_candidates: 0,
        unique_materials: [],
        duration_ms: Date.now() - started,
      },
      sources: [],
      duration_ms: Date.now() - started,
    };
  }

  const projectKey = params.projectKey?.trim() || BOUND_DATA_PROJECT_KEY;
  const index = await loadCodeUnitIndex(projectKey, {
    includeSourceCode: true,
  });
  const analyses = loadClassAnalysesMap(projectKey);

  const occurrences: HardcodedOccurrence[] = [];
  const excluded_all: Array<{ literal: string; reason: string }> = [];
  let units_scanned = 0;
  let units_with_matnr_context = 0;
  let literals_seen = 0;

  for (const unit of index.bySourceKey.values()) {
    units_scanned += 1;
    const code = unit.source_code;
    if (!code || code.length < 20) continue;
    // Cheap prefilter
    if (!/MATNR/i.test(code) && !/material/i.test(code)) continue;

    const scan = scanUnitForMaterialHardcodes(code);
    if (scan.has_matnr_context) units_with_matnr_context += 1;
    literals_seen += scan.literals_seen;
    for (const e of scan.excluded) {
      if (excluded_all.length < 80) excluded_all.push(e);
    }

    const analysisHint = extractAnalysisHint(
      analyses.get(unit.source_key) as Record<string, unknown> | undefined,
    );
    const analysisSummary = analysisHintToRationale(analysisHint);
    const processHint =
      processFromObjectName(unit.object_name) ??
      (analysisHint?.business_purpose
        ? analysisHint.business_purpose.slice(0, 80)
        : null);

    for (const hit of scan.hits) {
      let claim_status: HardcodedOccurrence["claim_status"] = "AUTHORITATIVE";
      let process_label: string | null = null;
      let process_rationale: string | null = null;

      if (hit.comment_only) {
        claim_status = "INFERRED";
        process_label = null;
        process_rationale = "Nur in Kommentar — keine aktive Steuerung.";
      } else if (analysisSummary) {
        claim_status = "CODE_DERIVED";
        process_label = processHint;
        process_rationale = analysisSummary;
      } else if (processHint) {
        claim_status = "CODE_DERIVED";
        process_label = processHint;
        process_rationale =
          "Prozessnähe aus Objektkontext und MATNR-Verwendung abgeleitet — keine fertige Methodenanalyse.";
      } else {
        claim_status = "AUTHORITATIVE";
        process_label = null;
        process_rationale =
          "Literal und MATNR-Kontext im Code belegt; fachlicher Prozess noch nicht aus Analyse ableitbar.";
      }

      occurrences.push({
        material_number: hit.material_number,
        material_number_internal: hit.material_number_internal,
        original_literal: hit.original_literal,
        source_key: unit.source_key,
        object_type: unit.object_type,
        object_name: unit.object_name,
        unit_name: unit.unit_name,
        unit_type: unit.unit_type,
        line_number: hit.line_number,
        snippet: hit.snippet,
        condition: hit.condition,
        action: hit.action,
        tables_fields: hit.tables_fields,
        active_code: hit.active_code,
        comment_only: hit.comment_only,
        confidence: hit.confidence,
        claim_status,
        process_label,
        process_rationale,
      });
    }
  }

  const draft_view = buildHardcodedValueAnswerView({
    occurrences,
    units_scanned,
    units_with_matnr_context,
    excluded_sample: excluded_all,
    sources: [
      "canonical/classes|programs|function-modules (source_code stream)",
      "analyses/classes/unit_analyses.jsonl",
      "canonical/master-data/materials/MARA (enrichment stage)",
    ],
  });

  const { view: answer_view, diagnostics: enrichmentDiag } =
    await enrichHardcodedValueAnswer({
      question: params.question,
      view: draft_view,
      projectKey,
      analyses,
    });

  const duration_ms = Date.now() - started;
  return {
    used: true,
    classification,
    answer_view,
    summary_sentence: answer_view.summary.text,
    sources: answer_view.sources,
    duration_ms,
    diagnostics: {
      classification,
      units_scanned,
      units_with_matnr_context,
      literals_seen,
      accepted_candidates: occurrences.filter((o) => o.active_code).length,
      excluded_candidates: excluded_all.length,
      unique_materials: answer_view.materials.map((m) => m.material_number),
      duration_ms,
      enrichment: enrichmentDiag,
    },
  };
}
