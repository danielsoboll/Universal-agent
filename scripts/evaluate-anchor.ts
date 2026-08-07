/**
 * Anchor evaluation CLI (generic). ZECD is only a fixture via --anchor.
 *
 *   npm run evaluate:anchor -- --project P01 --anchor ZECD \
 *     --query "Was wissen wir über die Nachricht ZECD?"
 *
 * Optional:
 *   --no-synthesize   ground truth + retrieval only
 *   --iterate N       run up to N optimization iterations (reports only; code changes are manual/agent)
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { runAnchorEvaluation } from "../src/lib/knowledge/evaluation/runAnchorEvaluation";
import { writeGeneratedText } from "../src/lib/localData/fs";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  const argv = process.argv.slice(2);
  const projectKey = argValue(argv, "--project")?.trim() || "P01";
  const anchor = argValue(argv, "--anchor")?.trim();
  const query = argValue(argv, "--query")?.trim();
  if (!anchor) {
    console.error("--anchor ist erforderlich (z.B. ZECD)");
    process.exit(2);
  }
  const question =
    query ||
    `Was wissen wir über die Nachricht ${anchor.toUpperCase()}?`;

  const synthesize = !hasFlag(argv, "--no-synthesize");
  const iterateRaw = Number(argValue(argv, "--iterate") ?? "1");
  const maxIter = Number.isFinite(iterateRaw)
    ? Math.max(1, Math.min(5, Math.floor(iterateRaw)))
    : 1;

  const history: Array<Record<string, unknown>> = [];

  for (let i = 1; i <= maxIter; i++) {
    console.error(`[evaluate:anchor] iteration ${i}/${maxIter} anchor=${anchor}`);
    const result = await runAnchorEvaluation({
      projectKey,
      anchor,
      question,
      iteration: i,
      synthesize,
      focused: true,
    });
    history.push({
      iteration: i,
      pass: result.report.pass,
      retrieval_recall: result.report.retrieval_recall,
      evidence_recall: result.report.evidence_recall,
      critical_entities_missing:
        result.report.critical_entities_missing.length,
      unsupported_answer_claims:
        result.report.unsupported_answer_claims.length,
      classified_gaps: result.report.classified_gaps.slice(0, 20),
      duration_ms: result.report.metrics.duration_ms,
      docs_scanned: result.report.metrics.documents_scanned,
      tokens_in: result.report.metrics.openai_input_tokens,
      answer_preview: result.direct_answer.slice(0, 400),
      paths: {
        ground_truth: result.ground_truth_path,
        retrieval: result.retrieval_path,
        openai_input: result.openai_input_path,
        openai_output: result.openai_output_path,
        report: result.report_path,
      },
    });

    console.log(JSON.stringify(history[history.length - 1], null, 2));

    if (result.report.pass) {
      console.error("[evaluate:anchor] pass criteria met — stop");
      break;
    }

    // Further iterations are for agent-driven code fixes between runs.
    // CLI alone cannot mutate pipeline stages; stop after first unless caller re-invokes.
    if (i < maxIter) {
      console.error(
        "[evaluate:anchor] gaps remain — apply pipeline fix then re-run (CLI does not auto-patch production code)",
      );
      break;
    }
  }

  writeGeneratedText(
    projectKey,
    "logs",
    `evaluation/${anchor.trim().toLowerCase()}/iteration-history.json`,
    `${JSON.stringify({ question, history }, null, 2)}\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
