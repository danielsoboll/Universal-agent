/**
 * Seed local demo project pointing at existing P01 knowledge index.
 *
 *   npm run seed:demo-project
 */
import { writeFileSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { KnowledgeRetriever } from "../src/lib/knowledge/knowledgeRetriever";
import { ensureSessionSecretFile, newId } from "../src/lib/localAuth/crypto";

function ensureLocalSessionSecretInEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (/^LOCAL_SESSION_SECRET=/m.test(text)) return;
  const secret = ensureSessionSecretFile();
  text += `\n# Local auth session HMAC (server only)\nLOCAL_SESSION_SECRET=${secret}\n`;
  writeFileSync(envPath, text, "utf8");
  console.log("LOCAL_SESSION_SECRET in .env.local ergänzt.");
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  ensureLocalSessionSecretInEnv();

  const existing = await fileProjectRepository.list();
  const id = existing[0]?.id ?? newId("proj");
  const project = await fileProjectRepository.upsert({
    id,
    name: "P01 Wissensbestand",
    description:
      "Lokales Demo-Projekt auf dem vorhandenen SearchDocument-Index (indexes/search).",
    customer_id: "P01",
    system_id: "D01",
    local_data_root: "",
    active_index_path: "indexes/search",
    enabled_knowledge_unit_types: [],
  });

  const status = KnowledgeRetriever.inspect(project);
  console.log("Projekt:", project.name);
  console.log("ID:", project.id);
  console.log("Customer/System:", project.customer_id, project.system_id);
  console.log("Index:", project.active_index_path);
  console.log("Prüfung:", status.message);
  if (!status.ok) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
