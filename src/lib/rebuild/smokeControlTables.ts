import type { LocalSearchIndex } from "@/lib/search/buildLocalSearchIndex";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";
import { searchTablesFulltext } from "@/lib/tables/searchTablesFulltext";
import type { RebuildSmokeResult } from "@/lib/rebuild/types";

function hitMentionsTable(
  hits: Array<{ title: string; source_key: string; snippet?: string }>,
  tableName: string,
): boolean {
  const t = tableName.toUpperCase();
  return hits.some(
    (h) =>
      h.title.toUpperCase().includes(t) ||
      h.source_key.toUpperCase().includes(t) ||
      (h.snippet ?? "").toUpperCase().includes(t),
  );
}

/**
 * Smoke tests for control-tables rebuild (index/search; no invented answers).
 */
export function smokeTestControlTables(params: {
  documents: SearchDocument[];
  index: LocalSearchIndex;
  knownTable: string;
  knownValue: string;
  missingTable: string;
  expectedRawFiles: string[];
  canonicalSourceFiles: string[];
}): RebuildSmokeResult[] {
  const results: RebuildSmokeResult[] = [];

  const findTable = searchTablesFulltext({
    query: params.knownTable,
    documents: params.documents,
    index: params.index,
    limit: 8,
  });
  const tableOk =
    findTable.hits.length > 0 &&
    hitMentionsTable(findTable.hits, params.knownTable);
  results.push({
    name: "Bekannte Tabelle finden",
    ok: tableOk,
    detail: tableOk
      ? `Treffer für ${params.knownTable}: ${findTable.hits.length}`
      : `Keine Treffer für bekannte Tabelle ${params.knownTable}`,
  });

  const findValue = searchTablesFulltext({
    query: `${params.knownTable} ${params.knownValue}`,
    documents: params.documents,
    index: params.index,
    limit: 8,
  });
  const valueOk =
    findValue.hits.length > 0 &&
    (hitMentionsTable(findValue.hits, params.knownTable) ||
      findValue.hits.some(
        (h) =>
          h.title.includes(params.knownValue) ||
          h.snippet.includes(params.knownValue) ||
          h.source_key.includes(params.knownValue),
      ));
  results.push({
    name: "Bekannten Tabellenwert finden",
    ok: valueOk,
    detail: valueOk
      ? `Treffer für Wert ${params.knownValue}`
      : `Kein Treffer für Wert ${params.knownValue} in ${params.knownTable}`,
  });

  const missing = searchTablesFulltext({
    query: params.missingTable,
    documents: params.documents,
    index: params.index,
    limit: 5,
  });
  const missingOk = !hitMentionsTable(missing.hits, params.missingTable);
  results.push({
    name: "Fehlende Tabelle ohne erfundene Treffer",
    ok: missingOk,
    detail: missingOk
      ? `Keine erfundenen Treffer für ${params.missingTable}`
      : `Unerwartete Treffer für nicht existierende Tabelle ${params.missingTable}`,
  });

  const expectedNorm = params.expectedRawFiles.map((f) =>
    f.replace(/^raw\//, ""),
  );
  const sourcesOk = expectedNorm.every((exp) =>
    params.canonicalSourceFiles.some(
      (c) => c === exp || c.endsWith(`/${exp.split("/").pop()}`) || c === exp.split("/").pop(),
    ),
  );
  results.push({
    name: "Quellen zeigen auf aktuelle Raw-Dateien",
    ok: sourcesOk,
    detail: sourcesOk
      ? `Quellen: ${params.canonicalSourceFiles.join(", ")}`
      : `Erwartet ${expectedNorm.join(", ")}, gefunden ${params.canonicalSourceFiles.join(", ") || "(leer)"}`,
  });

  return results;
}
