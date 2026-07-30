import { CONTROL_TABLE_ANALYSIS_PROMPT_VERSION } from "@/lib/analysis/controlTablePilotSchema";

export function buildControlTableAnalysisSystemPrompt(): string {
  return [
    "Du analysierst eine SAP-Steuer-/Customizingtabelle anhand von Definition und Zeilen.",
    "Antworte ausschließlich strukturiert gemäß Schema.",
    "",
    "Regeln:",
    "1. facts: nur direkt belegbar aus DDIC-Feldern, Tabellenbeschreibung, Zeilenwerten oder angegebenen Codeverwendungen.",
    "2. inferences: klare Schlussfolgerungen, getrennt von facts; jede Inference braucht evidence-Hinweise.",
    "3. Erfinde keine Bedeutung von Codes/Werten. Wenn unklar → unresolved_points.",
    "4. Interne Variablen/Parameternamen nicht als externe Systeme bezeichnen.",
    "5. Feldnamen nicht fachlich umdeuten ohne Beleg in Beschreibung oder Werten.",
    "6. confidence: 0.9–1.0 nur bei klaren Belegen; unter 0.6 bei vielen unresolved_points.",
    `7. prompt_version: ${CONTROL_TABLE_ANALYSIS_PROMPT_VERSION}`,
  ].join("\n");
}

export function buildControlTableAnalysisUserPrompt(input: {
  tableName: string;
  definitionJson: string;
  classificationJson: string;
  rowsJson: string;
  codeUsagesJson: string;
  selectionReason: string;
}): string {
  return [
    `Tabelle: ${input.tableName}`,
    `Auswahlgrund: ${input.selectionReason}`,
    "",
    "Definition (JSON):",
    input.definitionJson,
    "",
    "Klassifikation (JSON):",
    input.classificationJson,
    "",
    "Tabellenzeilen (JSON, ggf. gruppiert/repräsentativ):",
    input.rowsJson,
    "",
    "Bekannte Codeverwendungen (JSON, kann leer sein):",
    input.codeUsagesJson,
  ].join("\n");
}

export function buildCodeTableInterpretationSystemPrompt(): string {
  return [
    "Du interpretierst eine konkrete Verknüpfung zwischen einer ABAP-Code-Unit und einer aufgelösten Steuertabellenzeile.",
    "Antworte ausschließlich strukturiert gemäß Schema.",
    "",
    "Regeln:",
    "1. facts nur aus dem gelieferten Codeausschnitt und der konkreten Tabellenzeile.",
    "2. Geschäftsregeln gehören in inferences und business_rule_inferred (Inference), außer ein Codekommentar sagt es explizit.",
    "3. evidence_from_code: nur exakte Codezeilen aus dem Ausschnitt, Format L{n}|{Zeilentext} ohne Paraphrase und ohne '...'.",
    "4. evidence_from_table: nur konkrete Felder/Werte der gelieferten Zeile, keine Umschreibungen.",
    "5. Keine Generalisierung auf andere Schlüssel/Mandanten/Systeme.",
    "6. Keine erfundenen Weiterverwendungen — nur was im gelieferten Code sichtbar ist.",
    "7. Tabellenbeschreibung (TEXT1) nicht als ausgeführte Programmauswirkung ausgeben, wenn der Code den Wert nicht so verwendet.",
    "8. unresolved_points für Unklarheiten.",
    "9. prompt_version: code-table-interpretation-v1",
  ].join("\n");
}

export function buildCodeTableInterpretationUserPrompt(input: {
  className: string;
  methodName: string;
  tableName: string;
  codeSnippet: string;
  whereConditionsJson: string;
  tableRowJson: string;
  fieldDefsJson: string;
  unitAnalysisSummaryJson: string;
  tableAnalysisSummaryJson: string;
}): string {
  return [
    `Klasse: ${input.className}`,
    `Methode: ${input.methodName}`,
    `Tabelle: ${input.tableName}`,
    "",
    "Codeausschnitt mit Zeilennummern (Zugriff + unmittelbare Weiterverwendung):",
    "```abap",
    input.codeSnippet,
    "```",
    "",
    "WHERE-/Schlüsselbedingungen (JSON):",
    input.whereConditionsJson,
    "",
    "Aufgelöste Tabellenzeile (JSON):",
    input.tableRowJson,
    "",
    "Relevante Felddefinitionen (JSON):",
    input.fieldDefsJson,
    "",
    "Vorhandene Codeanalyse (Kurz, JSON):",
    input.unitAnalysisSummaryJson,
    "",
    "Vorhandene Tabellenanalyse (Kurz, JSON):",
    input.tableAnalysisSummaryJson,
    "",
    "Hinweis: evidence_from_code ausschließlich als L{n}|{exakter Zeilentext} aus dem Ausschnitt.",
  ].join("\n");
}
