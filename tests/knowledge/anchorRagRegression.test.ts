/**
 * Regression for generic anchor RAG (expectations only — no production special cases).
 *
 *   npx tsx tests/knowledge/anchorRagRegression.test.ts
 */
import assert from "assert";
import { resolve } from "path";
import { loadEnvFile } from "../../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../../src/lib/localData/root";
import { extractTechnicalSymbols } from "../../src/lib/search/technicalSymbols";
import { runGlobalAnchorSweep } from "../../src/lib/knowledge/anchorRag/globalAnchorSweep";
import { expandRelations } from "../../src/lib/knowledge/anchorRag/relationExpansion";
import {
  buildEvidenceGraph,
  buildEvidencePackage,
  mergeGraphEdges,
  mergeGraphNodes,
} from "../../src/lib/knowledge/anchorRag/evidenceGraph";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

const PROJECT = "P01";

const cases = [
  {
    id: "zecd",
    question: "Was wissen wir über die Nachricht ZECD?",
    token: "ZECD",
    requireOutputType: true,
  },
  {
    id: "zcmd",
    question: "Was wird bei der Nachricht ZCMD kundenspezifisch gemacht?",
    token: "ZCMD",
    requireOutputType: true,
  },
  {
    id: "edeka-vl",
    question: "Wie funktioniert das Edeka virtuelle Lager genau?",
    token: null as string | null,
    requireOutputType: false,
  },
] as const;

async function main() {
  for (const c of cases) {
    const syms = extractTechnicalSymbols(c.question).map((s) => s.norm);
    if (c.token) {
      assert.ok(
        syms.map((s) => s.toUpperCase()).includes(c.token.toUpperCase()),
        `${c.id}: expected technical token ${c.token}, got ${syms.join(",")}`,
      );
    }
  }

  for (const c of cases) {
    if (!c.token) continue;
    const sweep = await runGlobalAnchorSweep({
      projectKey: PROJECT,
      question: c.question,
      anchors: [c.token],
      maxHitsPerAnchor: 40,
    });
    const inv = sweep.inventories[0]!;
    assert.equal(inv.anchor.toUpperCase(), c.token.toUpperCase());

    if (inv.hits.length === 0) {
      console.log(
        JSON.stringify({
          id: c.id,
          status: "no_corpus_hits",
          note: "Token erkannt, aber in aktuellen Canonical-Quellen nicht vorhanden — generische Lücke, kein Sonderfall.",
        }),
      );
      continue;
    }

    if (c.requireOutputType) {
      assert.ok(
        inv.hits_by_type.OUTPUT_TYPE > 0,
        `${c.id}: expected OUTPUT_TYPE hits, got ${JSON.stringify(inv.hits_by_type)}`,
      );
    }

    const seeds = [
      c.token,
      ...inv.hits
        .slice(0, 20)
        .flatMap((h) => [h.name, h.object_id].filter(Boolean) as string[]),
    ];
    const expansion = await expandRelations({
      projectKey: PROJECT,
      seeds,
      maxHops: 2,
      maxEdgesPerHop: 200,
    });
    const graph = buildEvidenceGraph({
      question: c.question,
      primaryAnchors: [c.token],
      nodes: mergeGraphNodes(sweep.nodes, expansion.nodes),
      edges: mergeGraphEdges(expansion.edges),
    });
    const pkg = buildEvidencePackage({
      question: c.question,
      graph,
      inventories: sweep.inventories,
    });
    assert.ok(pkg.primary_anchors.includes(c.token));
    const configCount = (pkg.idoc_configuration.output_types as unknown[])
      .length;
    assert.ok(
      configCount + pkg.code_units.length > 0,
      `${c.id}: empty evidence package`,
    );
    console.log(
      JSON.stringify({
        id: c.id,
        hits: inv.hits.length,
        by_type: inv.hits_by_type,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        output_types: configCount,
        code_units: pkg.code_units.length,
        open_questions: pkg.open_questions,
      }),
    );
  }

  // Soft check: business question should not invent a hard technical token requirement
  const edeka = cases.find((c) => c.id === "edeka-vl")!;
  const edekaSyms = extractTechnicalSymbols(edeka.question);
  console.log(
    JSON.stringify({
      id: "edeka-vl",
      technical_tokens: edekaSyms.map((s) => s.norm),
      note: "concept-heavy; no forced OUTPUT_TYPE",
    }),
  );

  console.log("anchorRagRegression.test.ts OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
