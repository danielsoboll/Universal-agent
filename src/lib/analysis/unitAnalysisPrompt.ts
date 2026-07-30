import { UNIT_ANALYSIS_PROMPT_VERSION } from "@/lib/analysis/unitAnalysisSchema";

export function buildUnitAnalysisSystemPrompt(): string {
  return [
    "Du analysierst einzelne ABAP-Methoden einer SAP-Klasse.",
    "Antworte ausschließlich strukturiert gemäß Schema.",
    "",
    "Evidence:",
    "1. evidence_lines.line = 1-basierte Zeilennummer im übergebenen Quelltext.",
    "2. evidence_lines.quote muss die EXAKTE Originalzeile sein (kein Kürzen, kein '...').",
    "3. Mehrzeilige Statements: mehrere evidence_lines mit aufeinanderfolgenden Zeilen.",
    "4. Jede fact und jede inference braucht eigene evidence_lines (≥1).",
    "5. Nur aktive Codezeilen belegen — auskommentierte Zeilen (* …) sind KEINE Fakten.",
    "",
    "Fakten vs. Schlussfolgerungen:",
    "6. facts: nur direkt belegbare Codeaussagen aus aktivem Code.",
    "7. inferences: klare Schlussfolgerungen, getrennt von facts.",
    "",
    "Confidence:",
    "- 0.95–1.00: direkte, eindeutige Codeaussage",
    "- 0.75–0.94: starke Schlussfolgerung",
    "- 0.50–0.74: unsichere fachliche Einordnung",
    "- unter 0.50: zusätzlich open_questions; nie pauschal 0.95",
    "",
    "Tabellen:",
    "8. tables_read/tables_written nur für echte DDIC-DB-Zugriffe (SELECT/INSERT/UPDATE/MODIFY/DELETE).",
    "9. NICHT: interne Tabellen/Variablen (I_T_*, G_TA_*, L_TA_*, Parameter-Strukturen wie I_T_DEPOTS-ARG0).",
    "10. NICHT: Tabellen, die nur in Kommentaren vorkommen.",
    "",
    "Aufrufe:",
    "11. called_methods: nur Methodenaufrufe (-> / => / CALL METHOD), keine Makros.",
    "12. called_functions: nur CALL FUNCTION '…', niemals Methoden (auch nicht ME->…).",
    "13. ABAP-Makros (z. B. ANNAHME_ZEITEN_*, LOG_*_FAULT, CREATE_OT_ORDER_POSITION) NICHT in called_methods/called_functions — werden separat als macro_calls geführt.",
    "",
    "External Interfaces:",
    "Nur echte externe Anbindungen (Proxy/SOAP, RFC, HTTP/REST, File, IDoc, function_module, externe Systemnamen).",
    "NICHT: I_/E_/C_/G_/L_-Parameter, Klassenattribute, interne Tabellen.",
    "",
    "Weitere Regeln:",
    "14. CREATE OBJECT ist kein Methodenaufruf.",
    "15. SELECT SINGLE ist kein Funktionsbaustein.",
    `16. prompt_version: ${UNIT_ANALYSIS_PROMPT_VERSION}`,
  ].join("\n");
}

export function numberSourceLines(sourceCode: string): string {
  const lines = sourceCode.replace(/\r\n/g, "\n").split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, "0")}| ${line}`)
    .join("\n");
}

export function buildUnitAnalysisUserPrompt(input: {
  className: string;
  methodName: string;
  sourceKey: string;
  includeName?: string;
  numberedCode: string;
}): string {
  return [
    `Klasse: ${input.className}`,
    `Methode: ${input.methodName}`,
    `source_key: ${input.sourceKey}`,
    input.includeName ? `include_name: ${input.includeName}` : null,
    "",
    "ABAP-Quelltext mit Zeilennummern:",
    "```abap",
    input.numberedCode,
    "```",
  ]
    .filter((line) => line != null)
    .join("\n");
}
