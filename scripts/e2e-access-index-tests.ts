/**
 * End-to-End evaluation of the Access Index layer (no answer-logic changes).
 *
 *   npx tsx scripts/e2e-access-index-tests.ts
 *
 * For each question:
 * - runs answerQuestion (same path as /api/app/ask) under askPerf
 * - probes portable access indexes directly (symbol/literal/lexical/graph)
 * - reports what Ask actually used vs what the Access layer can find
 */
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import {
  answerQuestion,
  finalizeAskPerfOnResult,
} from "../src/lib/knowledge/answerQuestion";
import {
  askPerfMark,
  askPerfNote,
  resetAskPerfWarmState,
  runWithAskPerf,
} from "../src/lib/knowledge/askPerf";
import { clearLexicalCorpusCache } from "../src/lib/search/lexical/corpusCache";
import { clearProjectKnowledgeCache } from "../src/lib/knowledge/projectKnowledgeCache";
import {
  clearPortableIndexCache,
  isPortableIndexReady,
  loadPortableGraph,
  loadPortableManifest,
  lookupPortableLiteralsExact,
  lookupPortableSymbols,
} from "../src/lib/portableIndex/indexLoader";
import { getLexicalCorpusCached } from "../src/lib/search/lexical/corpusCache";
import { runLexicalSearch } from "../src/lib/search/lexical/runLexicalSearch";

const PROJECT = "P01";

type CaseId =
  | "exact_zecd"
  | "literal_4711"
  | "field_zz_vlager"
  | "relation_edioctopus"
  | "semantic_lager";

const CASES: Array<{
  id: CaseId;
  question: string;
  expected_primary_index: string;
}> = [
  {
    id: "exact_zecd",
    question: "Was wissen wir über ZECD?",
    expected_primary_index: "symbol + lexical (+ evidence via hybrid)",
  },
  {
    id: "literal_4711",
    question: "Wo ist 4711 hart codiert?",
    expected_primary_index: "literal-index (exact)",
  },
  {
    id: "field_zz_vlager",
    question: "Wo wird ZZ_VLAGER verwendet?",
    expected_primary_index: "symbol / field_usage / code_usage",
  },
  {
    id: "relation_edioctopus",
    question: "Was hängt technisch an EDIOCTOPUS?",
    expected_primary_index: "symbol + graph",
  },
  {
    id: "semantic_lager",
    question: "Wo wird entschieden, aus welchem Lager geliefert wird?",
    expected_primary_index: "lexical (+ optional vector later)",
  },
];

function inferAskIndexUsage(notes: string[], marks: Record<string, number>) {
  const joined = notes.join("\n");
  const used: string[] = [];
  let first: string | null = null;

  const push = (name: string) => {
    if (!used.includes(name)) used.push(name);
    if (!first) first = name;
  };

  if (/access path=literal|literal-index|literal exact lookup|literal miss/i.test(joined)) {
    push("literal-index");
  }
  if (/access path=symbol|symbol lookup|symbol-index|portable symbol/i.test(joined)) {
    push("symbol-index");
  }
  if (/graph neighbors|graph-index|Graph-Index/i.test(joined)) {
    push("graph-index");
  }
  if (/targeted evidence|evidence offsets|evidence-store|ACCESS_INDEX mode/i.test(joined)) {
    push("evidence-store");
  }
  if (/portable lexical|Lexical corpus|lexical-index/i.test(joined)) {
    push("lexical-index");
  }
  if (/code_usage|expandCodeUsages via portable/i.test(joined)) {
    push("symbol-index/code_usage_postings");
  }
  if (/indexes\/search|Search index loaded|fulltext_index|ASK_FORCE_LEGACY|legacy-hybrid|legacy search shards/i.test(joined)) {
    push("legacy-search-shards (indexes/search)");
  }
  if (/embeddings cache MISS|embeddings_load|openai_embedding|search_embeddings\.jsonl/i.test(joined)) {
    push("vector/embeddings");
  } else if (/embeddings skipped|enableVector=false|no vector needed/i.test(joined)) {
    // explicitly skipped
  }

  if (marks.lexical_corpus_load_start != null && !first) {
    first = "lexical-index";
  }

  return {
    first_index_used: first,
    indexes_used: used,
    embeddings_used: used.includes("vector/embeddings"),
    graph_used_in_ask: used.includes("graph-index"),
    literal_index_used_in_ask: used.includes("literal-index"),
    legacy_used: used.includes("legacy-search-shards (indexes/search)"),
  };
}

function probeAccessLayer(caseId: CaseId, question: string) {
  const probes: Record<string, unknown> = {
    portable_ready: isPortableIndexReady(PROJECT),
  };

  if (caseId === "exact_zecd" || caseId === "relation_edioctopus") {
    const sym = question.match(/\b([A-Z][A-Z0-9_]{2,})\b/g) ?? [];
    const names = [...new Set(sym.map((s) => s.toUpperCase()))].filter((s) =>
      /ZECD|EDIOCTOPUS|ZZ_VLAGER/.test(s) || s.length >= 4,
    );
    const focus =
      caseId === "exact_zecd"
        ? ["ZECD"]
        : caseId === "relation_edioctopus"
          ? ["EDIOCTOPUS"]
          : names;
    const hitMap = lookupPortableSymbols(PROJECT, focus);
    probes.symbol_lookup = Object.fromEntries(
      [...hitMap.entries()].map(([k, v]) => [k, v.length]),
    );
    probes.symbol_document_ids_sample = Object.fromEntries(
      [...hitMap.entries()].map(([k, v]) => [k, v.slice(0, 5)]),
    );
  }

  if (caseId === "literal_4711") {
    const all = lookupPortableLiteralsExact({
      projectId: PROJECT,
      value: "4711",
      limit: 50,
    });
    const mat = lookupPortableLiteralsExact({
      projectId: PROJECT,
      value: "4711",
      boundField: "MATNR",
      candidateRole: "material_number",
      limit: 50,
    });
    probes.literal_exact_4711 = all.length;
    probes.literal_4711_matnr_bound = mat.length;
    probes.literal_sample = all.slice(0, 3).map((h) => ({
      source_key: h.source_key,
      bound_fields: h.bound_fields,
      roles: h.candidate_roles,
      line: h.line_start,
      preview: h.statement_preview.slice(0, 120),
    }));
    probes.gap_if_zero =
      all.length === 0
        ? "Literal 4711 nicht in P01 code_units / literal-index. Kein künstliches Auffüllen."
        : null;
  }

  if (caseId === "field_zz_vlager") {
    const sym = lookupPortableSymbols(PROJECT, ["ZZ_VLAGER", "KNVV-ZZ_VLAGER"]);
    const lit = lookupPortableLiteralsExact({
      projectId: PROJECT,
      value: "ZZ_VLAGER",
      limit: 30,
    });
    // field postings are for DDIC fields like MATNR; ZZ_VLAGER may appear as literal/symbol
    probes.symbol_zz_vlager = Object.fromEntries(
      [...sym.entries()].map(([k, v]) => [k, v.length]),
    );
    probes.literal_zz_vlager = lit.length;
    probes.literal_sample = lit.slice(0, 5).map((h) => ({
      source_key: h.source_key,
      object_name: h.object_name,
      method: h.method_or_routine,
      bound_fields: h.bound_fields,
      preview: h.statement_preview.slice(0, 120),
    }));
  }

  if (caseId === "relation_edioctopus") {
    const g = loadPortableGraph(PROJECT);
    const needle = "EDIOCTOPUS";
    const nodes =
      g?.nodes.filter(
        (n) =>
          n.object_name.toUpperCase().includes(needle) ||
          n.node_id.toUpperCase().includes(needle),
      ) ?? [];
    const nodeIds = new Set(nodes.map((n) => n.node_id));
    const edges =
      g?.edges.filter(
        (e) => nodeIds.has(e.from_node_id) || nodeIds.has(e.to_node_id),
      ) ?? [];
    probes.graph_nodes_matching = nodes.length;
    probes.graph_edges_touching = edges.length;
    probes.graph_node_sample = nodes.slice(0, 8).map((n) => ({
      node_id: n.node_id,
      object_type: n.object_type,
      object_name: n.object_name,
    }));
    probes.graph_edge_sample = edges.slice(0, 8).map((e) => ({
      from: e.from_node_id,
      to: e.to_node_id,
      relation_type: e.relation_type,
      evidence_class: e.evidence_class,
    }));
    probes.gap_note =
      nodes.length === 0
        ? "EDIOCTOPUS nicht im portable graph-index (Nodes). Cross-Source-Linking/KG-Normalisierung prüfen."
        : edges.length === 0
          ? "Nodes gefunden, aber keine Edges — Graph-Linking unvollständig für diesen Anker."
          : null;
  }

  if (caseId === "semantic_lager") {
    const corpus = getLexicalCorpusCached(PROJECT);
    const lex = runLexicalSearch({
      question,
      documents: corpus,
      limit: 20,
    });
    probes.lexical_corpus_docs = corpus.length;
    probes.lexical_hits = lex.hits.length;
    probes.lexical_top = lex.hits.slice(0, 8).map((h) => ({
      id: h.doc.id,
      kind: h.doc.kind,
      technical_name: h.doc.technical_name,
      score: h.score,
      channels: h.channels,
    }));
    probes.vector_note =
      "Vector/Embeddings für diesen Test nicht aktiviert (enableVector=false / LOCAL_EXACT path).";
  }

  if (caseId === "exact_zecd") {
    const corpus = getLexicalCorpusCached(PROJECT);
    const lex = runLexicalSearch({
      question: "ZECD",
      documents: corpus,
      limit: 15,
    });
    probes.lexical_zecd_hits = lex.hits.length;
    probes.lexical_zecd_top = lex.hits.slice(0, 5).map((h) => ({
      technical_name: h.doc.technical_name,
      kind: h.doc.kind,
      score: h.score,
    }));
  }

  return probes;
}

async function runCase(
  c: (typeof CASES)[number],
  warmLabel: "cold" | "warm",
) {
  const access_probe = probeAccessLayer(c.id, c.question);

  const result = await runWithAskPerf(
    {
      question: c.question,
      forceCold: warmLabel === "cold",
    },
    async () => {
      askPerfMark("api_route_entered");
      askPerfNote(`e2e_case=${c.id}; expected_primary=${c.expected_primary_index}`);
      const projects = await fileProjectRepository.list();
      const project =
        projects.find((p) => p.customer_id === PROJECT) ?? projects[0];
      if (!project) throw new Error("Kein Projekt");
      const raw = await answerQuestion({
        projectId: project.id,
        project,
        question: c.question,
        searchMode: "direct_rag",
      });
      askPerfMark("api_response_sent");
      return finalizeAskPerfOnResult(raw);
    },
  );

  const perf = result.ask_perf;
  const usage = inferAskIndexUsage(perf?.notes ?? [], perf?.marks ?? {});

  const phaseMap: Record<string, number> = {};
  for (const ph of perf?.phases ?? []) {
    phaseMap[ph.name] = (phaseMap[ph.name] ?? 0) + ph.duration_ms;
  }

  const local_ms =
    Math.round(((perf?.total_ms ?? 0) - (perf?.openai_ms_total ?? 0)) * 10) /
    10;

  const evidence_loaded =
    (perf?.notes ?? []).some((n) =>
      /evidence|SearchDocuments|search_documents|portable evidence/i.test(n),
    ) || (result.sources?.length ?? 0) > 0;

  return {
    id: c.id,
    question: c.question,
    expected_primary_index: c.expected_primary_index,
    cold_or_warm: warmLabel,
    ask: {
      status: result.status,
      direct_answer_preview: (result.direct_answer || "").slice(0, 280),
      retrieval_summary: result.retrieval_summary,
      searched_document_count: result.searched_document_count,
      source_count: result.sources?.length ?? 0,
      top_sources: (result.sources ?? []).slice(0, 5).map((s) => ({
        rank: s.rank,
        title: s.title,
        source_key: s.source_key,
        object_name: s.object_name,
        score: s.combined_score,
      })),
      search_budget: result.search_budget,
      vector_search_active: result.vector_search_active,
      warnings: result.warnings?.slice(0, 12),
    },
    access_layer_probe: access_probe,
    ask_index_usage: usage,
    timings: {
      total_ms: perf?.total_ms ?? result.duration_ms,
      local_retrieval_ms: local_ms,
      openai_ms: perf?.openai_ms_total ?? 0,
      openai_calls: perf?.openai_calls ?? 0,
      phases_summed: phaseMap,
    },
    io: {
      fs_bytes_read: perf?.fs_bytes_total ?? 0,
      fs_read_count: perf?.fs_reads.length ?? 0,
      fs_parse_ms: perf?.fs_parse_ms_total ?? 0,
      top_reads: (perf?.fs_reads ?? [])
        .filter((r) => !r.cache_hit)
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 8)
        .map((r) => ({
          kind: r.kind,
          bytes: r.bytes,
          read_ms: r.read_ms,
          parse_ms: r.parse_ms,
        })),
    },
    evidence_loaded,
    knowledge_graph_used_in_ask: usage.graph_used_in_ask,
    embeddings_used: usage.embeddings_used,
    notes: perf?.notes?.slice(0, 25),
  };
}

function gapAssessment(row: Awaited<ReturnType<typeof runCase>>): string[] {
  const gaps: string[] = [];
  const probe = row.access_layer_probe as Record<string, unknown>;
  const bytes = row.io.fs_bytes_read;
  const legacy = row.ask_index_usage.legacy_used;

  if (legacy) {
    gaps.push("LEGACY: Ask hat noch legacy search shards geladen.");
  }

  if (row.id === "literal_4711") {
    if ((probe.literal_exact_4711 as number) === 0) {
      gaps.push(
        "DATEN: Literal 4711 kommt in P01-Code nicht vor (literal-index exact = 0) — korrekt dokumentiert.",
      );
    }
    if (row.embeddings_used) {
      gaps.push("VECTOR: Embeddings trotz Literal-Miss geladen — Fix prüfen.");
    }
    if (bytes > 50_000_000) {
      gaps.push(`IO: Literal-Pfad noch groß (${bytes} Bytes).`);
    }
  }

  if (row.id === "exact_zecd" || row.id === "relation_edioctopus") {
    if (legacy || bytes > 180_000_000) {
      gaps.push(
        `IO: Exact/Relation noch zu groß oder Legacy (${bytes} Bytes, legacy=${legacy}).`,
      );
    }
  }

  if (row.id === "field_zz_vlager") {
    const sym = probe.symbol_zz_vlager as Record<string, number> | undefined;
    if (!sym || Object.values(sym).every((n) => n === 0)) {
      gaps.push("DATEN/INDEX: ZZ_VLAGER nicht im symbol-index.");
    }
  }

  if (row.id === "relation_edioctopus") {
    if (!row.ask_index_usage.graph_used_in_ask) {
      gaps.push("ASK: graph-index nicht in Notes sichtbar.");
    }
  }

  if (row.id === "semantic_lager") {
    // Vector may be used — OK when Stage-1 semantic
  }

  return gaps;
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  const manifest = loadPortableManifest(PROJECT);
  if (!manifest || !isPortableIndexReady(PROJECT)) {
    console.error("Portable Access Index nicht bereit. Zuerst: npm run index:portable -- --customer P01");
    process.exit(2);
  }

  clearLexicalCorpusCache();
  clearProjectKnowledgeCache();
  clearPortableIndexCache();
  resetAskPerfWarmState();

  const results = [];
  for (const c of CASES) {
    console.log(`\n=== ${c.id}: ${c.question} ===`);
    // First request after clear ≈ cold for caches; subsequent cases share warm process cache
    const label = results.length === 0 ? "cold" : "warm";
    const row = await runCase(c, label);
    const gaps = gapAssessment(row);
    const out = { ...row, gaps };
    results.push(out);
    console.log(
      JSON.stringify(
        {
          status: row.ask.status,
          primary: row.ask_index_usage.first_index_used,
          indexes: row.ask_index_usage.indexes_used,
          legacy: row.ask_index_usage.legacy_used,
          vector: row.ask_index_usage.embeddings_used,
          sources: row.ask.source_count,
          files: row.io.top_reads.map((r) => r.kind),
          fs_bytes: row.io.fs_bytes_read,
          local_ms: row.timings.local_retrieval_ms,
          openai_ms: row.timings.openai_ms,
          total_ms: row.timings.total_ms,
          gaps,
        },
        null,
        2,
      ),
    );
  }

  const report = {
    measured_at: new Date().toISOString(),
    project: PROJECT,
    portable_manifest: {
      built_at: manifest.built_at,
      counts: manifest.counts,
      paths: manifest.paths,
    },
    note:
      "Ask nutzt Access Indices als Primary (kein Legacy-Full-Load). Literal-Miss ohne Embeddings. Graph bei bestätigten Seeds.",
    cases: results,
  };

  const outDir = resolve(process.cwd(), "tmp/regression");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "e2e-access-index-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
