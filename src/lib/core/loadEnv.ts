import { existsSync, readFileSync } from "fs";
import path from "path";

/** Shared .env.local loader for CLI scripts (no secrets logged). */
export function loadEnvFile(filename = ".env.local", cwd = process.cwd()) {
  try {
    const text = readFileSync(path.resolve(cwd, filename), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ")
        ? line.slice("export ".length).trim()
        : line;
      const eq = normalized.indexOf("=");
      if (eq <= 0) continue;
      const key = normalized.slice(0, eq).trim();
      let value = normalized.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!key) continue;
      if (!process.env[key] || process.env[key]?.trim() === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // caller validates LOCAL_DATA_ROOT
  }
}

export function tryReadGitHead(cwd = process.cwd()): string | null {
  try {
    const head = readFileSync(path.join(cwd, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      const refPath = path.join(cwd, ".git", ref);
      if (existsSync(refPath)) {
        return readFileSync(refPath, "utf8").trim().slice(0, 40);
      }
    }
    return head.slice(0, 40);
  } catch {
    return null;
  }
}
