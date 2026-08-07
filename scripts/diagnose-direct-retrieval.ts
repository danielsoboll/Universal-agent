/**
 * Retrieval-Diagnose für die echte Direct-Search-Route (KnowledgeRetriever).
 *
 *   npx tsx scripts/diagnose-direct-retrieval.ts --query "..."
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { KnowledgeRetriever } from "../src/lib/knowledge/knowledgeRetriever";
import {
  buildLexicalCorpus,
  normalizeLexicalQuery,
  runLexicalSearch,
} from "../src/lib/search/lexical";
import {
  exactQueryTerms,
  lexicalQueryTerms,
} from "../src/lib/search/hybridSearch";
import { BOUND_DATA_PROJECT_KEY } from "../src/lib/localData/boundProject";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  const query =
    argValue(process.argv.slice(2), "--query")?.trim() ||
    "Wie funktioniert das Edeka virtuelle Lager?";
  const projectKey = BOUND_DATA_PROJECT_KEY;

  const projects = await fileProjectRepository.list();
  const project =
    projects.find((p) => p.customer_id === projectKey) ?? projects[0];
  if (!project) throw new Error("Kein Projekt");

  const nq = normalizeLexicalQuery(query);
  console.log("=== 1. QUERY-NORMALISIERUNG (lexical) ===");
  console.log(JSON.stringify(nq, null, 2));
  console.log("\n=== Hybrid-Stopwords-Pfad (direct_rag heute) ===");
  console.log({
    lexicalQueryTerms: lexicalQueryTerms(query),
    exactQueryTerms: exactQueryTerms(query),
    search_path: "direct_rag → KnowledgeRetriever.search → hybridSearch",
    lexical_connected: false,
  });

  console.log("\n=== 2. LEXIKALISCHER SUCHLAUF (Canonical-Corpus) ===");
  const t0 = Date.now();
  const corpus = buildLexicalCorpus(projectKey);
  const byKind: Record<string, number> = {};
  for (const d of corpus) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  console.log({ corpus_size: corpus.length, byKind, ms: Date.now() - t0 });

  const lex = runLexicalSearch({
    question: query,
    documents: corpus,
    limit: 40,
  });
  console.log("diagnosis.counts", {
    exact_hits: lex.diagnosis.exact_hits,
    phrase_hits: lex.diagnosis.phrase_hits,
    all_term_hits: lex.diagnosis.all_term_hits,
    partial_hits: lex.diagnosis.partial_hits,
    bm25_hits: lex.diagnosis.bm25_hits,
    semantic_hits: lex.diagnosis.semantic_hits,
    char_ngram_hits: lex.diagnosis.char_ngram_hits,
  });
  console.log(
    "selected_primary_anchors",
    lex.diagnosis.selected_primary_anchors,
  );

  const channels = [
    "exact_phrase",
    "all_terms",
    "bm25",
    "partial_substring",
    "exact_technical",
    "semantic",
  ] as const;
  for (const ch of channels) {
    const hits = lex.hits.filter((h) => h.channels.includes(ch));
    console.log(`\n--- ${ch} (${hits.length}) ---`);
    for (const h of hits.slice(0, 10)) {
        console.log(
        JSON.stringify({
          rank: hits.indexOf(h) + 1,
          score: Number(h.score.toFixed(2)),
          kind: h.doc.kind,
          technical_name: h.doc.technical_name,
          field_text: (h.doc.field_text || h.doc.table_text || "").slice(0, 80),
          path: h.doc.source_path,
          reasons: Object.entries(h.boosts)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k}=${v}`),
          channels: h.channels,
        }),
      );
    }
  }

  console.log("\n=== 3. KNVV-ZZ_VLAGER ===");
  const knvv = corpus.find(
    (d) =>
      d.technical_name.includes("ZZ_VLAGER") ||
      (d.table_name === "KNVV" && d.field_name === "ZZ_VLAGER"),
  );
  const insp = KnowledgeRetriever.inspect(project);
  if (!knvv) {
    console.log("Canonical lexical doc: MISSING");
  } else {
    const st = knvv.search_text;
    console.log({
      id: knvv.id,
      kind: knvv.kind,
      technical_name: knvv.technical_name,
      field_text: knvv.field_text,
      source_path: knvv.source_path,
      search_text_contains: {
        KNVV: st.includes("KNVV"),
        ZZ_VLAGER: st.includes("ZZ_VLAGER"),
        "KNVV-ZZ_VLAGER": st.includes("KNVV-ZZ_VLAGER"),
        Edeka: /edeka/i.test(st),
        virtuell: /virtuell/i.test(st),
        Lager: /lager/i.test(st),
      },
      search_text_preview: st.slice(0, 350),
    });
  }

  // In hybrid index?
  const docs = insp.ok
    ? [...require("fs").readFileSync(insp.docs_path, "utf8")]
    : null;
  void docs;
  const { readFileSync } = await import("fs");
  let zzInIndex: Record<string, unknown> | null = null;
  if (insp.ok) {
    for (const line of readFileSync(insp.docs_path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (
        String(o.source_key || "").includes("ZZ_VLAGER") ||
        String(o.title || "").includes("KNVV-ZZ_VLAGER")
      ) {
        zzInIndex = {
          search_document_id: o.search_document_id,
          knowledge_unit_type: o.knowledge_unit_type,
          source_key: o.source_key,
          title: o.title,
          business_purpose: o.business_purpose,
          in_app_index: true,
          index_path: insp.docs_path,
        };
        break;
      }
    }
  }
  console.log("in_app_hybrid_index", zzInIndex ?? { in_app_index: false });

  for (const q of [
    "virtuelles Lager",
    "Edeka virtuelles Lager",
    "virtuell",
    "Lager",
  ]) {
    const r = runLexicalSearch({ question: q, documents: corpus, limit: 80 });
    const hit = r.hits.find(
      (h) =>
        h.doc.technical_name.includes("ZZ_VLAGER") ||
        (h.doc.table_name === "KNVV" && h.doc.field_name === "ZZ_VLAGER"),
    );
    console.log(
      `lexical rank "${q}":`,
      hit
        ? {
            rank: r.hits.indexOf(hit) + 1,
            score: hit.score,
            channels: hit.channels,
          }
        : "NOT_IN_TOP80",
    );
  }

  console.log("\n=== 4. KnowledgeRetriever (echte Direct-Search-Route) ===");
  const t1 = Date.now();
  const kr = await KnowledgeRetriever.search({
    project,
    query,
    limit: 20,
  });
  console.log({
    ms: Date.now() - t1,
    document_count: kr.document_count,
    vector_search_active: kr.vector_search_active,
    warnings: kr.warnings,
    index_path: kr.index_path,
  });
  for (const h of kr.hits) {
    console.log(
      JSON.stringify({
        rank: h.rank,
        score: Number(h.combined_score.toFixed(3)),
        type: h.knowledge_unit_type,
        key: h.source_key,
        title: h.title,
        exact: h.exact_score,
        fulltext: Number(h.fulltext_score.toFixed(3)),
        vector: Number(h.vector_score.toFixed(3)),
        meta: h.metadata_score,
        matched: h.matched_terms?.slice(0, 10),
        purpose: (h.business_purpose || "").slice(0, 80),
      }),
    );
  }
  const zzHybrid = kr.hits.find(
    (h) =>
      h.source_key?.includes("ZZ_VLAGER") || h.title?.includes("ZZ_VLAGER"),
  );
  console.log(
    "ZZ_VLAGER in hybrid top20:",
    zzHybrid
      ? { rank: zzHybrid.rank, score: zzHybrid.combined_score }
      : "ABSENT_FROM_TOP20",
  );

  console.log("\n=== 5. FEHLERKLASSIFIKATION (vor Korrektur) ===");
  const classes: string[] = [];
  if (!knvv) classes.push("DDIC_DOCUMENT_MISSING");
  else if (!knvv.field_text) classes.push("FIELD_TEXT_MISSING");
  else if (!/virtuell/i.test(knvv.search_text) || !/lager/i.test(knvv.search_text))
    classes.push("SEARCH_TEXT_INCOMPLETE");
  if (!zzInIndex) classes.push("INDEX_MISSING");
  classes.push("APP_ROUTE_NOT_CONNECTED"); // lexical only on multi-source today
  if (lexicalQueryTerms(query).includes("funktioniert"))
    classes.push("GERMAN_NORMALIZATION_MISSING");
  if (zzInIndex && !zzHybrid) classes.push("RANKING_ERROR");
  if (!zzHybrid) classes.push("EVIDENCE_FILTERED_OUT");
  classes.push("RELATION_EXPANSION_NOT_STARTED"); // no technical tokens → no anchor RAG
  console.log(classes);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
