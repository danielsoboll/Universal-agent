import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  const q = process.argv.slice(2).join(" ").trim() ||
    "Wie funktioniert das Edeka virtuelle Lager?";
  const r = await answerQuestion({
    projectId: "P01",
    question: q,
    searchMode: "direct_rag",
  });
  const out = {
    status: r.status,
    direct: r.direct_answer?.slice(0, 2000),
    confirmed: (r.process_answer?.confirmed ?? []).slice(0, 15).map((c) => c.text),
    tech_objects: (r.technical_answer?.objects ?? []).slice(0, 12).map((c) => c.text),
    tech_processing: (r.technical_answer?.processing ?? []).slice(0, 10).map((c) => c.text),
    sources: (r.sources ?? []).slice(0, 15).map((s) =>
      typeof s === "string"
        ? s
        : (s as { title?: string; source_key?: string }).title ||
          (s as { source_key?: string }).source_key,
    ),
    warnings: (r.warnings ?? [])
      .filter((w) => /enrich|Seed|Graph|Code|Enrichment/i.test(w))
      .slice(0, 12),
    open: (r.process_answer?.open ?? []).slice(0, 6).map((c) => c.text),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
