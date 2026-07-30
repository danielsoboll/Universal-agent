import type {
  DeterministicExtraction,
  ExtractionDeviation,
} from "@/lib/analysis/unitAnalysisSchema";
import { normalizeMethodName, normalizeToken } from "@/lib/analysis/abapExtract";

function normalizeList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((v) => normalizeToken(v))
        .filter((v) => v.length > 0),
    ),
  ].sort();
}

function normalizeMethodList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((v) => normalizeMethodName(v))
        .filter((v) => v.length > 0 && v !== "SINGLE"),
    ),
  ].sort();
}

function diffLists(
  field: ExtractionDeviation["field"],
  aiValues: string[],
  detValues: string[],
  normalizer: (values: string[]) => string[] = normalizeList,
): ExtractionDeviation | null {
  const ai = new Set(normalizer(aiValues));
  const det = new Set(normalizer(detValues));
  const onlyInAi = [...ai].filter((v) => !det.has(v)).sort();
  const onlyInDet = [...det].filter((v) => !ai.has(v)).sort();
  if (onlyInAi.length === 0 && onlyInDet.length === 0) return null;
  return {
    field,
    only_in_ai: onlyInAi,
    only_in_deterministic: onlyInDet,
  };
}

/** Compare AI lists vs deterministic ABAP extraction (methods via normalized names). */
export function compareExtractions(
  ai: {
    tables_read: string[];
    tables_written: string[];
    called_functions: string[];
    called_methods: string[];
  },
  deterministic: DeterministicExtraction,
): ExtractionDeviation[] {
  const aiFunctions = ai.called_functions.filter(
    (f) => !/^SELECT(\s+SINGLE)?$/i.test(f.trim()) && normalizeToken(f) !== "SINGLE",
  );

  return [
    diffLists("tables_read", ai.tables_read, deterministic.tables_read),
    diffLists("tables_written", ai.tables_written, deterministic.tables_written),
    diffLists("called_functions", aiFunctions, deterministic.called_functions),
    diffLists(
      "called_methods",
      ai.called_methods,
      deterministic.called_methods,
      normalizeMethodList,
    ),
  ].filter((d): d is ExtractionDeviation => d != null);
}
