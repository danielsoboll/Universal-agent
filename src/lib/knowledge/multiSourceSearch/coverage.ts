/**
 * Diagnose which multi-source corpora exist and how they can be searched.
 * Never invents indexes — missing → clear coverage status.
 */
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import { countJsonlLines } from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import type {
  MultiSourceId,
  SourceCoverage,
} from "@/lib/knowledge/multiSourceSearch/types";

async function lineCountOrNull(abs: string): Promise<number | null> {
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  // Cap scan for huge files — report estimate with note via caller
  const size = statSync(abs).size;
  if (size > 80 * 1024 * 1024) {
    // ~rough estimate: avg 400 bytes/line for master-data content
    return Math.round(size / 400);
  }
  return countJsonlLines(abs);
}

function dirExists(abs: string): boolean {
  return existsSync(abs) && statSync(abs).isDirectory();
}

export async function diagnoseSourceCoverage(
  projectKey: string,
): Promise<SourceCoverage[]> {
  const out: SourceCoverage[] = [];

  // --- exact_symbol (always available as cross-corpus pass) ---
  out.push({
    source: "exact_symbol",
    status: "ready",
    expected_path:
      "canonical/{master-data,programs,function-modules} + analyses/classes (symbol scan)",
    exists: true,
    record_count_estimate: null,
    searchable_via: [
      "exact_symbol_master_data",
      "exact_symbol_code_extracts",
      "exact_symbol_class_analyses",
    ],
    diagnosis:
      "Globale Exact-Symbol-Suche über Stammdatenstrukturen, Code-Extrakte und Klassenanalysen.",
  });

  // --- master_data ---
  const mdRoot = resolveProjectZonePath(
    projectKey,
    "canonical",
    "master-data",
  );
  const domains = ["materials", "customers", "vendors"];
  const structureFiles: string[] = [];
  let structureEstimate = 0;
  if (dirExists(mdRoot)) {
    for (const domain of domains) {
      const domainDir = path.join(mdRoot, domain);
      if (!dirExists(domainDir)) continue;
      for (const entry of readdirSync(domainDir)) {
        const struct = path.join(domainDir, entry, "structure.jsonl");
        if (existsSync(struct) && statSync(struct).isFile()) {
          structureFiles.push(struct);
          structureEstimate += (await lineCountOrNull(struct)) ?? 0;
        }
      }
    }
  }
  out.push({
    source: "master_data",
    status: structureFiles.length > 0 ? "ready" : "missing",
    expected_path: `canonical/master-data/{materials|customers|vendors}/*/structure.jsonl`,
    exists: structureFiles.length > 0,
    record_count_estimate: structureFiles.length > 0 ? structureEstimate : null,
    searchable_via: ["canonical_structure_stream", "canonical_content_stream"],
    diagnosis:
      structureFiles.length > 0
        ? `${structureFiles.length} structure.jsonl Dateien; nicht im Hybrid-Index.`
        : "Keine master-data structure.jsonl unter canonical/master-data.",
  });

  // --- control_tables ---
  const ctDefs = resolveProjectZonePath(
    projectKey,
    "canonical",
    "control-tables",
    "table_definitions.jsonl",
  );
  const ctRows = resolveProjectZonePath(
    projectKey,
    "canonical",
    "control-tables",
    "table_rows.jsonl",
  );
  const hybridDocs = resolveProjectZonePath(
    projectKey,
    "indexes",
    "search",
    "search_documents.jsonl",
  );
  const tablesIdx = resolveProjectZonePath(
    projectKey,
    "indexes",
    "tables",
    "search_documents.jsonl",
  );
  const ctReady = existsSync(ctDefs) || existsSync(hybridDocs);
  out.push({
    source: "control_tables",
    status: ctReady ? "ready" : "missing",
    expected_path:
      "canonical/control-tables/table_{definitions,rows}.jsonl + indexes/search|tables",
    exists: ctReady,
    record_count_estimate:
      (await lineCountOrNull(ctRows)) ??
      (await lineCountOrNull(hybridDocs)) ??
      null,
    searchable_via: [
      ...(existsSync(hybridDocs) ? ["hybrid_indexes/search"] : []),
      ...(existsSync(tablesIdx) ? ["indexes/tables"] : []),
      ...(existsSync(ctRows) ? ["canonical_table_rows_stream"] : []),
      ...(existsSync(ctDefs) ? ["canonical_table_definitions"] : []),
    ],
    diagnosis: ctReady
      ? `CT canonical ${existsSync(ctDefs) ? "ok" : "fehlt"}; hybrid ${existsSync(hybridDocs) ? "ok" : "fehlt"}; tables-index ${existsSync(tablesIdx) ? "ok" : "fehlt"}.`
      : "Weder CT-Canonical noch Hybrid-Index gefunden.",
  });

  // --- classes ---
  const classAnalyses = resolveProjectZonePath(
    projectKey,
    "analyses",
    "classes",
    "unit_analyses.jsonl",
  );
  const classCanonical = resolveProjectZonePath(
    projectKey,
    "canonical",
    "classes",
    "code_units.jsonl",
  );
  const classPartial =
    existsSync(classAnalyses) || existsSync(classCanonical);
  const analysisCount = await lineCountOrNull(classAnalyses);
  const unitCount = await lineCountOrNull(classCanonical);
  out.push({
    source: "classes",
    status: !classPartial
      ? "missing"
      : analysisCount != null &&
          unitCount != null &&
          analysisCount > 0 &&
          analysisCount < unitCount * 0.5
        ? "partial"
        : existsSync(classAnalyses)
          ? "ready"
          : "partial",
    expected_path:
      "analyses/classes/unit_analyses.jsonl (+ canonical/classes; hybrid code_unit)",
    exists: classPartial,
    record_count_estimate: analysisCount ?? unitCount,
    searchable_via: [
      ...(existsSync(hybridDocs) ? ["hybrid_code_unit"] : []),
      ...(existsSync(classAnalyses) ? ["analyses_unit_stream"] : []),
      ...(existsSync(classCanonical) ? ["canonical_code_units_stream"] : []),
    ],
    diagnosis: classPartial
      ? `Analyses≈${analysisCount ?? "?"}, canonical units≈${unitCount ?? "?"}; hybrid enthält nur gemergte code_units.`
      : "Keine Klassen-Analyses/Canonical gefunden.",
  });

  // --- programs ---
  const progExtracts = resolveProjectZonePath(
    projectKey,
    "canonical",
    "programs",
    "extracts.jsonl",
  );
  out.push({
    source: "programs",
    status: existsSync(progExtracts) ? "ready" : "missing",
    expected_path: "canonical/programs/extracts.jsonl",
    exists: existsSync(progExtracts),
    record_count_estimate: await lineCountOrNull(progExtracts),
    searchable_via: existsSync(progExtracts)
      ? ["canonical_extracts_stream"]
      : [],
    diagnosis: existsSync(progExtracts)
      ? "Canonical extracts vorhanden; nicht im Hybrid-Index."
      : "canonical/programs/extracts.jsonl fehlt.",
  });

  // --- function_modules ---
  const fmExtracts = resolveProjectZonePath(
    projectKey,
    "canonical",
    "function-modules",
    "extracts.jsonl",
  );
  out.push({
    source: "function_modules",
    status: existsSync(fmExtracts) ? "ready" : "missing",
    expected_path: "canonical/function-modules/extracts.jsonl",
    exists: existsSync(fmExtracts),
    record_count_estimate: await lineCountOrNull(fmExtracts),
    searchable_via: existsSync(fmExtracts)
      ? ["canonical_extracts_stream"]
      : [],
    diagnosis: existsSync(fmExtracts)
      ? "Canonical extracts vorhanden; nicht im Hybrid-Index."
      : "canonical/function-modules/extracts.jsonl fehlt.",
  });

  // --- relations ---
  const classRel = resolveProjectZonePath(
    projectKey,
    "canonical",
    "classes",
    "relations.jsonl",
  );
  const progRel = resolveProjectZonePath(
    projectKey,
    "canonical",
    "programs",
    "relations.jsonl",
  );
  const fmRel = resolveProjectZonePath(
    projectKey,
    "canonical",
    "function-modules",
    "relations.jsonl",
  );
  const ctRel = resolveProjectZonePath(
    projectKey,
    "canonical",
    "control-tables",
    "table_relations.jsonl",
  );
  const anyRel =
    existsSync(classRel) ||
    existsSync(progRel) ||
    existsSync(fmRel) ||
    existsSync(ctRel);
  out.push({
    source: "relations",
    status: anyRel ? "ready" : "missing",
    expected_path:
      "canonical/{classes,programs,function-modules}/relations.jsonl + control-tables/table_relations.jsonl",
    exists: anyRel,
    record_count_estimate:
      ((await lineCountOrNull(classRel)) ?? 0) +
      ((await lineCountOrNull(progRel)) ?? 0) +
      ((await lineCountOrNull(fmRel)) ?? 0),
    searchable_via: anyRel
      ? ["canonical_relations_stream", "hybrid_relation_index"]
      : [],
    diagnosis: anyRel
      ? "Relations-Dateien vorhanden (Streaming + optional hybrid 1-hop)."
      : "Keine Relations-Dateien gefunden.",
  });

  return out;
}

export function coverageBySource(
  coverage: SourceCoverage[],
): Record<MultiSourceId, SourceCoverage | undefined> {
  const map: Partial<Record<MultiSourceId, SourceCoverage>> = {};
  for (const c of coverage) map[c.source] = c;
  return map as Record<MultiSourceId, SourceCoverage | undefined>;
}
