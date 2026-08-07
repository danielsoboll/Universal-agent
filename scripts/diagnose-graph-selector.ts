/**
 * Diagnose Graph-Selector (Phase 2) — no OpenAI, no writes to analyses.
 *
 *   npx tsx scripts/diagnose-graph-selector.ts --question "Was macht ZECD?"
 *   npx tsx scripts/diagnose-graph-selector.ts --anchor ZECD --anchor ZRAH
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveWritablePath } from "../src/lib/localData/paths";
import {
  loadClassAnalysesMap,
  loadCodeUnitIndex,
  loadKnowledgeGraph,
  selectCodeUnitsFromGraph,
} from "../src/lib/knowledge/graphSelector";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function argAll(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) {
      out.push(process.argv[i + 1]!);
    }
  }
  return out;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q)) return v.slice(1, -1);
  }
  return v;
}

function loadDotEnv() {
  try {
    const text = readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ")
        ? line.slice("export ".length).trim()
        : line;
      const eq = normalized.indexOf("=");
      if (eq <= 0) continue;
      const key = normalized.slice(0, eq).trim();
      const value = stripQuotes(normalized.slice(eq + 1));
      if (!key) continue;
      if (!process.env[key] || process.env[key]?.trim() === "") {
        process.env[key] = value;
      }
    }
  } catch {
    /* validated later */
  }
}

async function runOne(params: {
  projectKey: string;
  question: string;
  anchors: string[];
  maxHops: number;
  maxCodeUnits: number;
  graph: Awaited<ReturnType<typeof loadKnowledgeGraph>>;
  codeUnits: Awaited<ReturnType<typeof loadCodeUnitIndex>>;
  analyses: Map<string, Record<string, unknown>>;
}) {
  return selectCodeUnitsFromGraph({
    projectKey: params.projectKey,
    question: params.question,
    anchors: params.anchors,
    maxHops: params.maxHops,
    maxCodeUnits: params.maxCodeUnits,
    graph: params.graph,
    codeUnits: params.codeUnits,
    analyses: params.analyses,
  });
}

function printCompact(label: string, result: Awaited<ReturnType<typeof runOne>>) {
  console.log(`\n======== ${label} ========`);
  console.log(`question: ${result.question}`);
  console.log(`anchors: ${result.anchors.join(", ") || "(from question)"}`);
  console.log(
    `seeds: ${result.seeds.length} | selected: ${result.selected.length} | held_back: ${result.held_back.length}`,
  );
  console.log(
    `coverage: seeds=${result.evidence_coverage.seeds_found} auth_config=${result.evidence_coverage.authoritative_config_nodes} code_nodes=${result.evidence_coverage.code_nodes_reached} cache_hits=${result.evidence_coverage.selected_with_cache_hit} need_openai=${result.evidence_coverage.selected_needing_openai} expansion=${result.evidence_coverage.expansion_over_cap_recommended}`,
  );
  if (result.evidence_coverage.gaps.length) {
    console.log(`gaps: ${result.evidence_coverage.gaps.join(", ")}`);
  }
  console.log("--- selected ---");
  for (const s of result.selected) {
    console.log(
      [
        `#${s.rank}`,
        s.source_key,
        `reason=${s.ranking_reason}`,
        `path_hops=${s.graph_path.length}`,
        `seed=${s.seed_node_id}`,
        `cache=${s.cache_status}/${s.cache_reason}`,
        `openai=${s.would_need_openai ? "ja" : "nein"}`,
      ].join(" | "),
    );
  }
}

async function main() {
  loadDotEnv();
  loadEnvFile();
  const projectKey = argValue("--project") ?? "P01";
  void getLocalDataRoot();

  const question = argValue("--question") ?? "";
  const anchors = argAll("--anchor");
  const maxHops = Number(argValue("--max-hops") ?? "2");
  const maxCodeUnits = Number(argValue("--max") ?? "30");
  const examples = process.argv.includes("--examples-abc");

  console.log("Lade Knowledge Graph + Code-Units (read-only)…");
  const graph = await loadKnowledgeGraph(projectKey);
  const codeUnits = await loadCodeUnitIndex(projectKey, {
    // Needed for field-like needles (ZZ_VLAGER) that only appear in source.
    includeSourceCode: true,
  });
  const analyses = loadClassAnalysesMap(projectKey);
  console.log(
    `nodes=${graph.nodes.size} edges=${graph.edges.length} code_units=${codeUnits.bySourceKey.size} analyses=${analyses.size}`,
  );

  const outDir = resolveWritablePath(
    projectKey,
    "logs",
    "graph-selector",
  );
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  if (examples) {
    const cases = [
      {
        label: "ZECD",
        question: "Was macht die Ausgabestart ZECD?",
        anchors: ["ZECD"],
      },
      {
        label: "ZRAH",
        question: "Wie hängt ZRAH mit Preisfindung zusammen?",
        anchors: ["ZRAH"],
      },
      {
        label: "ZZ_VLAGER",
        question: "Wofür wird ZZ_VLAGER verwendet?",
        anchors: ["ZZ_VLAGER", "KNVV-ZZ_VLAGER", "ZZTVAG"],
      },
    ];
    const all: Record<string, unknown> = {};
    for (const c of cases) {
      const result = await runOne({
        projectKey,
        question: c.question,
        anchors: c.anchors,
        maxHops,
        maxCodeUnits,
        graph,
        codeUnits,
        analyses,
      });
      printCompact(c.label, result);
      all[c.label] = result;
    }
    const outPath = path.join(outDir, "examples-abc.json");
    writeFileSync(outPath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    console.log(`\nDiagnose geschrieben: ${outPath}`);
    return;
  }

  if (!question && anchors.length === 0) {
    console.error(
      "Usage: --question \"...\" und/oder --anchor SYM [--examples-abc]",
    );
    process.exit(1);
  }

  const result = await runOne({
    projectKey,
    question: question || anchors.join(" "),
    anchors,
    maxHops,
    maxCodeUnits,
    graph,
    codeUnits,
    analyses,
  });
  printCompact("diagnose", result);
  const outPath = path.join(outDir, "last-diagnose.json");
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`\nDiagnose geschrieben: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
