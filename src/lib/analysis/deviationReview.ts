import {
  extractAbapArtifacts,
  normalizeMethodName,
  normalizeToken,
} from "@/lib/analysis/abapExtract";
import { compareExtractions } from "@/lib/analysis/extractionCompare";
import { isMacroName } from "@/lib/analysis/macroExtract";
import type { UnitAnalysisRecord } from "@/lib/analysis/unitAnalysisSchema";

export const DEVIATION_CLASSIFICATIONS = [
  "REAL_AI_ADDITION",
  "REAL_DETERMINISTIC_ADDITION",
  "NORMALIZATION_ONLY",
  "PARSER_FALSE_POSITIVE",
  "AI_FALSE_POSITIVE",
  "AMBIGUOUS",
] as const;

export type DeviationClassification =
  (typeof DEVIATION_CLASSIFICATIONS)[number];

export type DeviationReviewEntry = {
  source_key: string;
  class_name: string;
  method_name: string;
  deviation_type: "only_in_ai" | "only_in_deterministic";
  field:
    | "tables_read"
    | "tables_written"
    | "called_functions"
    | "called_methods";
  deterministic_value: string | null;
  ai_value: string | null;
  classification: DeviationClassification;
  explanation: string;
  relevant_source_lines: Array<{ line: number; text: string }>;
  requires_fix: boolean;
  recommended_action: string;
};

function sourceLines(code: string): string[] {
  return code.replace(/\r\n/g, "\n").split("\n");
}

function findLines(
  code: string,
  predicate: (line: string) => boolean,
  limit = 8,
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  sourceLines(code).forEach((text, i) => {
    if (predicate(text) && out.length < limit) {
      out.push({ line: i + 1, text });
    }
  });
  return out;
}

function isCommentedSelectTable(code: string, table: string): boolean {
  const re = new RegExp(`^\\s*\\*.*\\bFROM\\s+${table}\\b`, "i");
  return sourceLines(code).some((l) => re.test(l));
}

function hasActiveFromTable(code: string, table: string): boolean {
  const lines = sourceLines(code);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^\s*\*/.test(l)) continue;
    if (new RegExp(`\\bFROM\\s+${table}\\b`, "i").test(l)) return true;
    if (new RegExp(`\\bJOIN\\s+${table}\\b`, "i").test(l)) return true;
  }
  return false;
}

function hasMacroInvocation(code: string, name: string): boolean {
  const re = new RegExp(`(^|\\s)${name}\\s+`, "i");
  return sourceLines(code).some((l) => !/^\s*\*/.test(l) && re.test(l));
}

function hasMethodCall(code: string, method: string): boolean {
  const n = normalizeMethodName(method);
  const reArrow = new RegExp(`->\\s*${n}\\s*\\(`, "i");
  const reStatic = new RegExp(`(?:=\\>|~)\\s*${n}\\s*\\(`, "i");
  const reCall = new RegExp(`CALL\\s+METHOD\\s+(?:\\S+->)?${n}\\b`, "i");
  return sourceLines(code).some(
    (l) =>
      !/^\s*\*/.test(l) &&
      (reArrow.test(l) || reStatic.test(l) || reCall.test(l)),
  );
}

function hasAttributeAccess(code: string, name: string): boolean {
  const n = normalizeToken(name);
  const re = new RegExp(`->\\s*${n}\\s*=`, "i");
  return sourceLines(code).some((l) => !/^\s*\*/.test(l) && re.test(l));
}

function hasStaticAttribute(code: string, name: string): boolean {
  const n = normalizeToken(name);
  // class=>ATTR used as value, not ATTR(
  const re = new RegExp(`=>\\s*${n}(?!\\s*\\()`, "i");
  return sourceLines(code).some((l) => !/^\s*\*/.test(l) && re.test(l));
}

/**
 * Classify one atomic deviation value against the method source.
 */
export function classifyDeviationValue(params: {
  field: DeviationReviewEntry["field"];
  side: "only_in_ai" | "only_in_deterministic";
  value: string;
  sourceCode: string;
  aiValues: string[];
  deterministicValues: string[];
}): Omit<
  DeviationReviewEntry,
  | "source_key"
  | "class_name"
  | "method_name"
  | "deviation_type"
  | "field"
  | "deterministic_value"
  | "ai_value"
> {
  const { field, side, value, sourceCode, aiValues, deterministicValues } =
    params;
  const normalized = normalizeMethodName(value);
  const aiNorm = new Set(aiValues.map(normalizeMethodName));
  const detNorm = new Set(deterministicValues.map(normalizeMethodName));

  // Normalization-only for methods
  if (field === "called_methods") {
    if (side === "only_in_ai" && detNorm.has(normalized)) {
      return {
        classification: "NORMALIZATION_ONLY",
        explanation:
          "Gleiche Methode; AI mit Receiver-/Interface-Präfix, deterministic normalisiert auf Methodennamen.",
        relevant_source_lines: findLines(
          sourceCode,
          (l) =>
            l.toUpperCase().includes(normalized) &&
            /(->|=>|~|CALL\s+METHOD)/i.test(l),
        ),
        requires_fix: false,
        recommended_action:
          "Vergleich weiter über normalized_method_name; AI-Präfixe belassen.",
      };
    }
    if (side === "only_in_deterministic" && aiNorm.has(normalized)) {
      return {
        classification: "NORMALIZATION_ONLY",
        explanation:
          "Gleiche Methode; deterministic hat Normalform, AI listet Präfixvariante.",
        relevant_source_lines: findLines(
          sourceCode,
          (l) =>
            l.toUpperCase().includes(normalized) &&
            /(->|=>|~|CALL\s+METHOD)/i.test(l),
        ),
        requires_fix: false,
        recommended_action: "Keine inhaltliche Korrektur nötig.",
      };
    }
  }

  if (side === "only_in_deterministic" && field === "called_methods") {
    if (hasAttributeAccess(sourceCode, value) || hasStaticAttribute(sourceCode, value)) {
      return {
        classification: "PARSER_FALSE_POSITIVE",
        explanation:
          "Deterministische Extraktion hat Attribut-/Konstantenzugriff fälschlich als Methode erkannt.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          l.toUpperCase().includes(normalizeToken(value)),
        ),
        requires_fix: true,
        recommended_action:
          "Parser: ->/=> nur bei Aufrufsyntax '(' oder EXPORTING/… als Methode werten.",
      };
    }
    if (normalizeToken(value) === "ADJACENT") {
      return {
        classification: "PARSER_FALSE_POSITIVE",
        explanation: "DELETE ADJACENT DUPLICATES fälschlich als Tabelle ADJACENT.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          /DELETE\s+ADJACENT/i.test(l),
        ),
        requires_fix: true,
        recommended_action: "DELETE ADJACENT DUPLICATES vom Write-Parser ausschließen.",
      };
    }
    if (hasMethodCall(sourceCode, value)) {
      return {
        classification: "REAL_DETERMINISTIC_ADDITION",
        explanation: "Eindeutiger Methodenaufruf im Code; KI hat ihn in diesem Feld ausgelassen.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          l.toUpperCase().includes(normalized),
        ),
        requires_fix: false,
        recommended_action:
          "KI-Ausgabe nicht löschen; bei nächster Analyse Prompt/Validierung schärfen.",
      };
    }
  }

  if (side === "only_in_ai" && field === "called_functions") {
    if (/^SELECT(\s+SINGLE)?$/i.test(value.trim())) {
      return {
        classification: "AI_FALSE_POSITIVE",
        explanation: "SELECT SINGLE ist kein Funktionsbaustein.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          /SELECT\s+SINGLE/i.test(l),
        ),
        requires_fix: false,
        recommended_action: "Aus called_functions filtern (bereits im Compare).",
      };
    }
    if (hasMethodCall(sourceCode, value) || detNorm.has(normalized)) {
      return {
        classification: "AI_FALSE_POSITIVE",
        explanation:
          "KI hat Methodenaufruf fälschlich unter called_functions geführt.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          l.toUpperCase().includes(normalized),
        ),
        requires_fix: false,
        recommended_action: "Als Methode führen, nicht als function_module.",
      };
    }
    if (
      isMacroName(normalizeToken(value), new Set()) ||
      hasMacroInvocation(sourceCode, normalizeToken(value))
    ) {
      return {
        classification: "NORMALIZATION_ONLY",
        explanation:
          "ABAP-Makroaufruf — wird unter macro_calls / CALLS_MACRO geführt, nicht als function.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          new RegExp(`\\b${normalizeToken(value)}\\b`, "i").test(l),
        ),
        requires_fix: false,
        recommended_action: "In macro_calls belassen; aus called_functions entfernen.",
      };
    }
  }

  if (side === "only_in_ai" && field === "called_methods") {
    if (
      isMacroName(normalizeToken(value), new Set()) ||
      hasMacroInvocation(sourceCode, normalizeToken(value))
    ) {
      return {
        classification: "NORMALIZATION_ONLY",
        explanation:
          "Makroaufruf — eigenes Feld macro_calls / Relation CALLS_MACRO, keine Methode.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          new RegExp(`\\b${normalizeToken(value)}\\b`, "i").test(l),
        ),
        requires_fix: false,
        recommended_action: "In macro_calls belassen; aus called_methods entfernen.",
      };
    }
    if (hasMethodCall(sourceCode, value)) {
      return {
        classification: "REAL_AI_ADDITION",
        explanation:
          "Methodenaufruf im Code vorhanden; deterministic hat ihn in dieser Form nicht gelistet.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          l.toUpperCase().includes(normalized),
        ),
        requires_fix: false,
        recommended_action: "Behalten; Normalisierung prüfen.",
      };
    }
    return {
      classification: "AI_FALSE_POSITIVE",
      explanation: "Kein entsprechender Methodenaufruf im Code gefunden.",
      relevant_source_lines: [],
      requires_fix: false,
      recommended_action: "Nicht in Embeddings/Retrieval als harte Kante übernehmen.",
    };
  }

  if (side === "only_in_ai" && (field === "tables_read" || field === "tables_written")) {
    const table = normalizeToken(value);
    if (table.includes("-") || /^(I_|E_|G_|L_|C_)/.test(table)) {
      return {
        classification: "AI_FALSE_POSITIVE",
        explanation:
          "Parameter-/Strukturkomponente oder interne Tabelle, kein DDIC-Tabellenzugriff.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          l.toUpperCase().includes(table.split("-")[0] ?? table),
        ),
        requires_fix: false,
        recommended_action: "Aus tables_read/tables_written entfernen bzw. ignorieren.",
      };
    }
    if (isCommentedSelectTable(sourceCode, table) && !hasActiveFromTable(sourceCode, table)) {
      return {
        classification: "AI_FALSE_POSITIVE",
        explanation: "Tabelle kommt nur in auskommentiertem SELECT vor.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          l.toUpperCase().includes(table),
        ),
        requires_fix: false,
        recommended_action: "Nicht als gelesene DB-Tabelle übernehmen.",
      };
    }
    if (field === "tables_written" && !hasActiveFromTable(sourceCode, table)) {
      // APPEND TO itab
      const appendHits = findLines(sourceCode, (l) =>
        new RegExp(`APPEND\\b.*\\b${table}\\b|\\b${table}\\b`, "i").test(l),
      );
      if (appendHits.length > 0) {
        return {
          classification: "AI_FALSE_POSITIVE",
          explanation:
            "Interne Tabelle / Work-Area, kein DB-MODIFY/INSERT/UPDATE/DELETE.",
          relevant_source_lines: appendHits,
          requires_fix: false,
          recommended_action: "Nicht als tables_written (DB) führen.",
        };
      }
    }
    if (hasActiveFromTable(sourceCode, table)) {
      return {
        classification: "REAL_AI_ADDITION",
        explanation: "DB-Tabellenzugriff im Code; deterministic hat ihn verpasst.",
        relevant_source_lines: findLines(sourceCode, (l) =>
          new RegExp(`\\b${table}\\b`, "i").test(l),
        ),
        requires_fix: true,
        recommended_action: "FROM/JOIN-Extraktion prüfen.",
      };
    }
    return {
      classification: "AMBIGUOUS",
      explanation: "Tabellenbezug nicht eindeutig aus dem Code ableitbar.",
      relevant_source_lines: findLines(sourceCode, (l) =>
        l.toUpperCase().includes(table),
      ),
      requires_fix: false,
      recommended_action: "Manuell prüfen.",
    };
  }

  if (side === "only_in_deterministic") {
    return {
      classification: "AMBIGUOUS",
      explanation: "Deterministischer Mehrfund ohne klare Kategorie.",
      relevant_source_lines: findLines(sourceCode, (l) =>
        l.toUpperCase().includes(normalizeToken(value)),
      ),
      requires_fix: false,
      recommended_action: "Manuell prüfen.",
    };
  }

  return {
    classification: "AMBIGUOUS",
    explanation: "Nicht eindeutig klassifizierbar.",
    relevant_source_lines: [],
    requires_fix: false,
    recommended_action: "Manuell prüfen.",
  };
}

export function expandAndClassifyDeviations(params: {
  analysis: Pick<
    UnitAnalysisRecord,
    | "source_key"
    | "class_name"
    | "method_name"
    | "tables_read"
    | "tables_written"
    | "called_functions"
    | "called_methods"
  >;
  sourceCode: string;
  deviations: ReturnType<typeof compareExtractions>;
}): DeviationReviewEntry[] {
  const out: DeviationReviewEntry[] = [];
  for (const d of params.deviations) {
    const aiField =
      d.field === "tables_read"
        ? params.analysis.tables_read
        : d.field === "tables_written"
          ? params.analysis.tables_written
          : d.field === "called_functions"
            ? params.analysis.called_functions
            : params.analysis.called_methods;
    const det = extractAbapArtifacts(params.sourceCode);
    const detField =
      d.field === "tables_read"
        ? det.tables_read
        : d.field === "tables_written"
          ? det.tables_written
          : d.field === "called_functions"
            ? det.called_functions
            : det.called_methods;

    for (const value of d.only_in_ai) {
      const c = classifyDeviationValue({
        field: d.field,
        side: "only_in_ai",
        value,
        sourceCode: params.sourceCode,
        aiValues: aiField,
        deterministicValues: detField,
      });
      out.push({
        source_key: params.analysis.source_key,
        class_name: params.analysis.class_name,
        method_name: params.analysis.method_name,
        deviation_type: "only_in_ai",
        field: d.field,
        deterministic_value: null,
        ai_value: value,
        ...c,
      });
    }
    for (const value of d.only_in_deterministic) {
      const c = classifyDeviationValue({
        field: d.field,
        side: "only_in_deterministic",
        value,
        sourceCode: params.sourceCode,
        aiValues: aiField,
        deterministicValues: detField,
      });
      out.push({
        source_key: params.analysis.source_key,
        class_name: params.analysis.class_name,
        method_name: params.analysis.method_name,
        deviation_type: "only_in_deterministic",
        field: d.field,
        deterministic_value: value,
        ai_value: null,
        ...c,
      });
    }
  }
  return out;
}
