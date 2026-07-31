/**
 * Seed local demo users (admin + user). Password never printed unless --print-password.
 *
 *   npm run seed:demo-user
 *   npm run seed:demo-user -- --password '...' --print-password
 */
import { resolve } from "path";
import { randomBytes } from "crypto";
import { writeFileSync } from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { appConfigPath, hashPassword, newId } from "../src/lib/localAuth/crypto";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { fileUserRepository } from "../src/lib/localAuth/userRepository";

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();

  const argv = process.argv.slice(2);
  const printPassword = argv.includes("--print-password");
  const password =
    argValue(argv, "--password")?.trim() ||
    `Demo-${randomBytes(6).toString("base64url")}`;

  const projects = await fileProjectRepository.list();
  if (!projects[0]) {
    console.error("Kein Projekt. Zuerst: npm run seed:demo-project");
    process.exit(2);
  }
  const project = projects[0];
  const password_hash = await hashPassword(password);

  const adminEmail = "admin@local.test";
  const userEmail = "user@local.test";

  let admin = await fileUserRepository.getByEmail(adminEmail);
  admin = await fileUserRepository.upsert({
    id: admin?.id ?? newId("user"),
    email: adminEmail,
    display_name: "Lokaler Admin",
    role: "admin",
    project_ids: [project.id],
    password_hash,
    enabled: true,
  });

  let user = await fileUserRepository.getByEmail(userEmail);
  user = await fileUserRepository.upsert({
    id: user?.id ?? newId("user"),
    email: userEmail,
    display_name: "Lokaler User",
    role: "user",
    project_ids: [project.id],
    password_hash,
    enabled: true,
  });

  const secretNote = appConfigPath("demo_password.txt");
  writeFileSync(
    secretNote,
    [
      "# Lokales Demo-Passwort — nicht committen, nicht loggen.",
      `# erzeugt: ${new Date().toISOString()}`,
      password,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  console.log("Demo-Benutzer eingerichtet:");
  console.log(`- Admin: ${admin.email} · Rolle admin · Projekt ${project.name}`);
  console.log(`- User:  ${user.email} · Rolle user · Projekt ${project.name}`);
  console.log(`- Initiales Passwort abgelegt unter: ${secretNote}`);
  if (printPassword) {
    console.log(`- Passwort (explizit angefordert): ${password}`);
  } else {
    console.log(
      "- Passwort nicht in der Konsole ausgegeben (nutze --print-password falls nötig).",
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
