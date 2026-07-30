import type {
  AnalysisRelation,
  DeterministicExtraction,
  UnitAnalysisRecord,
} from "@/lib/analysis/unitAnalysisSchema";
import {
  extractAbapArtifacts,
  normalizeMethodName,
  normalizeToken,
} from "@/lib/analysis/abapExtract";
import { compareExtractions } from "@/lib/analysis/extractionCompare";
import { extractMacroCalls, isMacroName } from "@/lib/analysis/macroExtract";
import { partitionExternalInterfaces } from "@/lib/analysis/interfaceClassify";
import { unitAnalysisRecordSchema } from "@/lib/analysis/unitAnalysisSchema";

function isInternalDataObject(name: string): boolean {
  const n = normalizeToken(name);
  if (!n) return true;
  if (n.includes("-")) return true; // structure component e.g. I_T_DEPOTS-ARG0
  if (/^(I_|E_|C_|L_|G_|LT_|GT_|LS_|GS_|IT_|IS_|WA_|P_|R_)/.test(n)) return true;
  return false;
}

function tableOnlyInComment(sourceCode: string, table: string): boolean {
  const t = normalizeToken(table);
  const lines = sourceCode.replace(/\r\n/g, "\n").split("\n");
  let active = false;
  let commented = false;
  for (const line of lines) {
    if (!new RegExp(`\\b${t}\\b`, "i").test(line)) continue;
    if (/^\s*\*/.test(line)) commented = true;
    else active = true;
  }
  return commented && !active;
}

function stripMacros(values: string[], knownMacros: Set<string>): string[] {
  return values.filter((v) => !isMacroName(normalizeMethodName(v), knownMacros));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => normalizeToken(v)).filter(Boolean))].sort();
}

function buildSearchText(input: {
  methodName: string;
  className: string;
  technicalSummary: string;
  facts: string[];
  tables: string[];
  methods: string[];
  functions: string[];
  macros: string[];
  interfaces: string[];
}): string {
  return [
    input.className,
    input.methodName,
    input.technicalSummary,
    ...input.facts,
    ...input.tables,
    ...input.methods,
    ...input.functions,
    ...input.macros,
    ...input.interfaces,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Post-process an analysis record:
 * - remove AI false positives (comment-only tables, internal objects, macros-as-methods)
 * - merge deterministic method facts
 * - attach macro_calls + CALLS_MACRO relations
 * - rebuild deviations / search_text / provenance
 */
export function enrichUnitAnalysisRecord(params: {
  record: Record<string, unknown>;
  sourceCode: string;
  knownMacros: Set<string>;
}): UnitAnalysisRecord {
  const raw = params.record;
  const sourceCode = params.sourceCode;
  const knownMacros = params.knownMacros;

  const deterministicBase = extractAbapArtifacts(sourceCode);
  const macroCalls = extractMacroCalls(sourceCode, knownMacros);
  const deterministic: DeterministicExtraction = {
    ...deterministicBase,
    macro_calls: macroCalls,
  };

  let tablesRead = Array.isArray(raw.tables_read)
    ? [...(raw.tables_read as string[])]
    : [];
  let tablesWritten = Array.isArray(raw.tables_written)
    ? [...(raw.tables_written as string[])]
    : [];
  let calledFunctions = Array.isArray(raw.called_functions)
    ? [...(raw.called_functions as string[])]
    : [];
  let calledMethods = Array.isArray(raw.called_methods)
    ? [...(raw.called_methods as string[])]
    : [];

  const originalAiMethods = new Set(
    calledMethods.map((m) => normalizeMethodName(m)).filter(Boolean),
  );

  const fieldProvenance: Array<{
    field: "called_methods" | "tables_read" | "tables_written" | "called_functions";
    value: string;
    source_type: "ai" | "deterministic_extraction";
  }> = [];

  // 1) Remove macros from method/function lists; move misfiled methods
  calledMethods = stripMacros(calledMethods, knownMacros).map(normalizeMethodName);
  const keptFunctions: string[] = [];
  for (const f of stripMacros(calledFunctions, knownMacros)) {
    const n = normalizeMethodName(f);
    if (!n || /^SELECT(\s+SINGLE)?$/i.test(f)) continue;
    const looksLikeMethod =
      deterministic.called_methods.includes(n) || /->|=>|~/.test(f);
    if (looksLikeMethod) {
      if (!calledMethods.includes(n)) calledMethods.push(n);
      continue;
    }
    keptFunctions.push(n);
  }
  calledFunctions = keptFunctions;

  // 2) Remove comment-only / internal tables
  tablesRead = tablesRead.filter((t) => {
    if (isInternalDataObject(t)) return false;
    if (tableOnlyInComment(sourceCode, t)) return false;
    return true;
  });
  tablesWritten = tablesWritten.filter((t) => {
    if (isInternalDataObject(t)) return false;
    if (tableOnlyInComment(sourceCode, t)) return false;
    return true;
  });

  // 3) Merge deterministic methods that AI omitted (or only misfiled as functions)
  const methodSet = new Set(calledMethods.map(normalizeMethodName));
  for (const detMethod of deterministic.called_methods) {
    methodSet.add(detMethod);
  }
  calledMethods = [...methodSet].sort();

  for (const m of calledMethods) {
    const fromDeterministic = deterministic.called_methods.includes(m);
    const fromAiOnly = originalAiMethods.has(m) && !fromDeterministic;
    fieldProvenance.push({
      field: "called_methods",
      value: m,
      source_type: fromDeterministic
        ? "deterministic_extraction"
        : fromAiOnly
          ? "ai"
          : "ai",
    });
  }

  // Deduplicate provenance
  const provKey = new Set<string>();
  const provenance = fieldProvenance.filter((p) => {
    const k = `${p.field}|${p.value}|${p.source_type}`;
    if (provKey.has(k)) return false;
    provKey.add(k);
    return true;
  });

  const iface = partitionExternalInterfaces(
    Array.isArray(raw.external_interfaces)
      ? (raw.external_interfaces as string[])
      : [],
  );

  const relations: AnalysisRelation[] = macroCalls
    .filter((m) => !m.unresolved_macro)
    .map((m) => ({
      relation_type: "CALLS_MACRO" as const,
      from_type: "METHOD" as const,
      from_name: String(raw.method_name ?? ""),
      to_type: "MACRO" as const,
      to_name: m.name,
    }));

  const facts = Array.isArray(raw.facts) ? raw.facts : [];
  const factTexts = facts.map((f: unknown) => {
    if (typeof f === "string") return f;
    if (f && typeof f === "object" && "text" in f) {
      return String((f as { text: string }).text ?? "");
    }
    return "";
  });

  const search_text = buildSearchText({
    methodName: String(raw.method_name ?? ""),
    className: String(raw.class_name ?? ""),
    technicalSummary: String(raw.technical_summary ?? ""),
    facts: factTexts,
    tables: [...tablesRead, ...tablesWritten],
    methods: calledMethods,
    functions: calledFunctions.map(normalizeToken),
    macros: macroCalls.map((m) => m.name),
    interfaces: iface.real.map((r) => r.name),
  });

  const cleanedAi = {
    tables_read: uniqueSorted(tablesRead),
    tables_written: uniqueSorted(tablesWritten),
    called_functions: uniqueSorted(calledFunctions.map(normalizeMethodName)),
    called_methods: calledMethods,
  };

  // Deviations: compare cleaned AI lists vs deterministic, ignoring macros
  const extraction_deviations = compareExtractions(
    cleanedAi,
    deterministic,
  ).map((d) => ({
    ...d,
    only_in_ai: d.only_in_ai.filter((v) => !isMacroName(v, knownMacros)),
    only_in_deterministic: d.only_in_deterministic.filter(
      (v) => !isMacroName(v, knownMacros),
    ),
  })).filter((d) => d.only_in_ai.length > 0 || d.only_in_deterministic.length > 0);

  return unitAnalysisRecordSchema.parse({
    ...raw,
    tables_read: cleanedAi.tables_read,
    tables_written: cleanedAi.tables_written,
    called_functions: cleanedAi.called_functions,
    called_methods: cleanedAi.called_methods,
    external_interfaces: iface.real.map((r) => r.name),
    external_interfaces_classified: iface.real,
    discarded_interfaces: iface.discarded,
    deterministic,
    extraction_deviations,
    macro_calls: macroCalls,
    relations,
    search_text,
    field_provenance: provenance,
    needs_reanalysis: false,
  });
}

