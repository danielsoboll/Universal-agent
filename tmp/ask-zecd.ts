import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const projects = await fileProjectRepository.list();
  const project = projects.find((p) => p.customer_id === "P01") ?? projects[0]!;
  const r = await answerQuestion({
    projectId: project.id,
    question: "Was wissen wir über die Nachricht ZECD?",
    searchMode: "direct_rag",
    limit: 12,
  });
  console.log(
    JSON.stringify(
      {
        status: r.status,
        retrieval_mode: r.retrieval_mode,
        technical_objects: r.technical_objects,
        sources_top: r.sources.slice(0, 8).map((s) => ({
          title: s.title,
          kut: s.knowledge_unit_type,
          exact: s.exact_score,
        })),
        direct_answer: r.direct_answer.slice(0, 1500),
        evidence_notes: r.evidence_context_report?.notes?.slice(0, 10),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
