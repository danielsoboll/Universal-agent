/**
 * Verify project's active knowledge index.
 *
 *   npm run verify:knowledge-index
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { KnowledgeRetriever } from "../src/lib/knowledge/knowledgeRetriever";

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const projects = await fileProjectRepository.list();
  if (!projects[0]) {
    console.error("Kein lokales Projekt. npm run seed:demo-project");
    process.exit(2);
  }
  const project = projects[0];
  const status = KnowledgeRetriever.inspect(project);
  console.log(JSON.stringify({ project_id: project.id, ...status }, null, 2));
  if (!status.ok) process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
