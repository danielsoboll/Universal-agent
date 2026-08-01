/**
 * CLI ask — same answerQuestion service as the web UI.
 *
 *   npm run ask -- --project <id> --query "..." [--mode direct_rag|planned_rag]
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
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
    searchMode:
      argValue(argv, "--mode") === "planned_rag" ? "planned_rag" : "direct_rag",
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "error") process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
