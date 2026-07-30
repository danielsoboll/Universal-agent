/**
 * Verify LOCAL_DATA_ROOT from .env.local and the sandbox rules.
 * Run: npm run local-data:check
 *
 * Does not copy or modify anything under raw/.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { LocalDataError } from "../src/lib/localData/errors";
import {
  assertPathWithinRoot,
  assertRawReadPath,
  assertWritablePath,
  resolveRawPath,
  resolveWritablePath,
} from "../src/lib/localData/paths";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { READ_ONLY_ZONE, WRITABLE_ZONES } from "../src/lib/localData/zones";

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q)) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function loadEnvFile(filename: string) {
  try {
    const text = readFileSync(resolve(process.cwd(), filename), "utf8");
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
    // optional until required below
  }
}

function fail(message: string): never {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

function main() {
  loadEnvFile(".env.local");

  let root: string;
  try {
    root = getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) {
      fail(error.message);
    }
    throw error;
  }

  const repoRoot = resolve(process.cwd());
  if (root === repoRoot || root.startsWith(`${repoRoot}/`)) {
    fail(
      `LOCAL_DATA_ROOT liegt innerhalb des Git-Repos (${repoRoot}). Kundendaten müssen außerhalb liegen.`,
    );
  }

  const projects = readdirSync(root).filter((name) => {
    if (name.startsWith(".")) return false;
    try {
      return statSync(resolve(root, name)).isDirectory();
    } catch {
      return false;
    }
  });

  const projectChecks = projects.map((projectKey) => {
    const zones = {
      raw: existsSync(resolveRawPath(projectKey)),
      ...Object.fromEntries(
        WRITABLE_ZONES.map((zone) => [
          zone,
          existsSync(resolveWritablePath(projectKey, zone)),
        ]),
      ),
    };

    // Soft validation of zone rules (no writes).
    assertRawReadPath(resolveRawPath(projectKey));
    for (const zone of WRITABLE_ZONES) {
      assertWritablePath(resolveWritablePath(projectKey, zone));
    }

    return { projectKey, zones };
  });

  // Escape attempt must fail.
  let escapeBlocked = false;
  try {
    assertPathWithinRoot(resolve(root, "..", "outside.txt"), root);
  } catch (error) {
    escapeBlocked =
      error instanceof LocalDataError && error.code === "PATH_ESCAPE";
  }
  if (!escapeBlocked) {
    fail(
      "Path-Escape-Check fehlgeschlagen: Zugriff außerhalb des Roots wurde nicht blockiert.",
    );
  }

  let rawWriteBlocked = false;
  try {
    assertWritablePath(resolveRawPath(projects[0] ?? "P01", "probe.txt"));
  } catch (error) {
    rawWriteBlocked =
      error instanceof LocalDataError && error.code === "RAW_WRITE_FORBIDDEN";
  }
  if (!rawWriteBlocked) {
    fail(`Schreiben unter ${READ_ONLY_ZONE}/ wurde nicht blockiert.`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        localDataRoot: root,
        outsideRepo: true,
        projects: projectChecks,
        rules: {
          raw: "read-only",
          writable: [...WRITABLE_ZONES],
          noCopyIntoGit: true,
        },
      },
      null,
      2,
    ),
  );
}

main();
