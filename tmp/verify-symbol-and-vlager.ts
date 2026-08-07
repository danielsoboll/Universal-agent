import { resolve } from "path";
import { readFileSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { KnowledgeRetriever } from "../src/lib/knowledge/knowledgeRetriever";
import { parseSearchDocumentsJsonl } from "../src/lib/search/buildSearchDocuments";
import { extractTechnicalSymbols } from "../src/lib/search/technicalSymbols";

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const projects = await fileProjectRepository.list();
  const project =
    projects.find((p) => p.customer_id === "P01") ?? projects[0]!;

  const docs = [
    ...parseSearchDocumentsJsonl(
      readFileSync(
        "/Users/DanielSon/SAP_AI_Exports/P01/indexes/search/search_documents.jsonl",
        "utf8",
      ),
    ).values(),
  ];
  const mf = docs.find(
    (d) =>
      d.knowledge_unit_type === "master_field" &&
      d.object_name === "KNVV" &&
      d.subobject_name === "ZZ_VLAGER",
  );
  console.log(
    "MASTER_FIELD_DOC",
    mf
      ? {
          id: mf.search_document_id,
          title: mf.title,
          source_key: mf.source_key,
          search_text_preview: (mf.search_text || "").slice(0, 500),
          has_knvv: (mf.search_text || "").includes("KNVV"),
          has_zz: (mf.search_text || "").toUpperCase().includes("ZZ_VLAGER"),
          has_feldtext: (mf.search_text || "").includes(
            "Kennzeichen virtuelles Lager",
          ),
          has_de: (mf.search_text || "").includes("ZZ_SD_VLAGER"),
          facts: mf.facts,
          metadata: mf.metadata,
        }
      : null,
  );

  const queries = [
    "ZZ_VLAGER",
    "KNVV-ZZ_VLAGER",
    "Edeka virtuelles Lager",
    "virtuelles Lager",
    "Was wissen wir über die Nachricht ZECD?",
  ];
  for (const q of queries) {
    console.log("\n=== QUERY:", q, "===");
    console.log(
      "symbols",
      extractTechnicalSymbols(q).map((s) => s.norm),
    );
    const result = await KnowledgeRetriever.search({
      project,
      query: q,
      limit: 8,
      enableRelationExpansion: false,
    });
    console.log(
      result.hits.slice(0, 5).map((h) => ({
        rank: h.rank,
        kut: h.knowledge_unit_type,
        title: h.title,
        object: h.object_name,
        sub: h.subobject_name,
        exact: h.exact_score,
        score: Number(h.combined_score.toFixed(2)),
      })),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
