/**
 * CLI ask — same answerQuestion service as the web UI.
 *
 *   npm run ask -- --project <id> --query "..." [--mode direct_rag|planned_rag|full_analysis|deep_search]
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";
import type { SearchMode } from "../src/lib/knowledge/queryPlanSchema";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function resolveMode(raw: string | undefined): SearchMode {
  if (raw === "planned_rag") return "planned_rag";
  if (raw === "full_analysis") return "full_analysis";
  if (raw === "deep_search" || raw === "ki_tiefensuche") return "deep_search";
  return "direct_rag";
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const argv = process.argv.slice(2);
  const query = argValue(argv, "--query")?.trim();
  if (!query) {
    console.error("--query ist erforderlich");
    process.exit(2);
  }
  let projectId = argValue(argv, "--project")?.trim();
  if (!projectId) {
    const projects = await fileProjectRepository.list();
    projectId = projects[0]?.id;
  }
  if (!projectId) {
    console.error("Kein Projekt. npm run seed:demo-project");
    process.exit(2);
  }

  const result = await answerQuestion({
    projectId,
    question: query,
    searchMode: resolveMode(argValue(argv, "--mode")),
  });
  // Avoid dumping huge base64 in CLI stdout
  const { full_analysis_report, ...rest } = result;
  const out =
    full_analysis_report != null
      ? {
          ...rest,
          full_analysis_report: {
            title: full_analysis_report.title,
            filename_stem: full_analysis_report.filename_stem,
            version: full_analysis_report.version,
            markdown_chars: full_analysis_report.markdown.length,
            docx_bytes: Math.floor(
              (full_analysis_report.docx_base64.length * 3) / 4,
            ),
          },
        }
      : rest;
  console.log(JSON.stringify(out, null, 2));
  if (result.status === "error") process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
