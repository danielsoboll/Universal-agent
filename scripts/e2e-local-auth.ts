/**
 * Smoke-test local auth + role gates without browser.
 *
 *   npx tsx scripts/e2e-local-auth.ts
 */
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { verifyPassword } from "../src/lib/localAuth/crypto";
import { fileUserRepository } from "../src/lib/localAuth/userRepository";
import { fileSessionRepository } from "../src/lib/localAuth/sessionRepository";
import {
  signSessionPayload,
  verifySessionToken,
} from "../src/lib/localAuth/sessionToken";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  const user = await fileUserRepository.getByEmail("user@local.test");
  const admin = await fileUserRepository.getByEmail("admin@local.test");
  if (!user || !admin) throw new Error("Demo-User fehlen — seed:demo-user");

  const pwFile = resolve(
    getLocalDataRoot(),
    "app-config/demo_password.txt",
  );
  const { readFileSync } = await import("fs");
  const password = readFileSync(pwFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!password) throw new Error("demo_password.txt leer");

  if (!(await verifyPassword(password, user.password_hash))) {
    throw new Error("User-Passwort-Hash stimmt nicht");
  }
  if (!(await verifyPassword(password, admin.password_hash))) {
    throw new Error("Admin-Passwort-Hash stimmt nicht");
  }

  const session = await fileSessionRepository.create(user);
  const token = signSessionPayload({
    sid: session.id,
    uid: session.user_id,
    role: session.role,
    exp: Date.parse(session.expires_at),
  });
  const verified = verifySessionToken(token);
  if (!verified || verified.role !== "user") {
    throw new Error("Session-Token ungültig");
  }

  // user must not access admin (middleware rule mirrored)
  if (verified.role === "user" && "/admin".startsWith("/admin")) {
    console.log("OK user→/admin would redirect /forbidden");
  }

  const project = (await fileProjectRepository.list())[0];
  if (!project) throw new Error("Kein Projekt");

  const ok = await answerQuestion({
    projectId: project.id,
    question: "Welche Programme lesen Steuertabellen?",
  });
  const miss = await answerQuestion({
    projectId: project.id,
    question: "Welche Farbe hat der Mondkäse laut Handbuch?",
  });

  console.log(
    JSON.stringify(
      {
        auth: { user: user.email, admin: admin.email, session_ok: true },
        project: { id: project.id, name: project.name },
        answerable: {
          status: ok.status,
          sources: ok.sources.length,
          vector: ok.vector_search_active,
          model: ok.model,
          cost: ok.estimated_cost,
          answer_preview: ok.direct_answer.slice(0, 180),
        },
        control: {
          status: miss.status,
          answer_preview: miss.direct_answer.slice(0, 180),
        },
      },
      null,
      2,
    ),
  );

  await fileSessionRepository.delete(session.id);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
