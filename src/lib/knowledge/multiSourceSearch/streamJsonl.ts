/**
 * Streaming JSONL helpers — one record at a time, no full-file load.
 */
import { createReadStream, existsSync, statSync } from "fs";
import { createInterface } from "readline";

export async function* streamJsonlObjects(
  absolutePath: string,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return;
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          yield obj as Record<string, unknown>;
        }
      } catch {
        // skip malformed lines
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * Stream JSONL objects whose raw line contains at least one needle (case-insensitive).
 * Skips JSON.parse for non-matching lines — used for focused exact-symbol paths.
 */
export async function* streamJsonlObjectsMatching(
  absolutePath: string,
  needles: string[],
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return;
  const upperNeedles = needles
    .map((n) => n.trim().toUpperCase())
    .filter((n) => n.length >= 2);
  if (upperNeedles.length === 0) return;
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const upper = trimmed.toUpperCase();
      if (!upperNeedles.some((n) => upper.includes(n))) continue;
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          yield obj as Record<string, unknown>;
        }
      } catch {
        // skip malformed lines
      }
    }
  } finally {
    rl.close();
  }
}

/** Count non-empty lines without parsing (fast estimate). */
export async function countJsonlLines(
  absolutePath: string,
  maxScan?: number,
): Promise<number> {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return 0;
  const rl = createInterface({
    input: createReadStream(absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let n = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      n += 1;
      if (maxScan != null && n >= maxScan) break;
    }
  } finally {
    rl.close();
  }
  return n;
}

export function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

export function normalizeToken(value: string): string {
  return value.trim().toUpperCase();
}

/** Case-insensitive substring / token match against haystack. */
export function textMatchesAny(
  haystack: string,
  needles: string[],
): string | null {
  if (!haystack || needles.length === 0) return null;
  const upper = haystack.toUpperCase();
  for (const n of needles) {
    const needle = n.trim().toUpperCase();
    if (needle.length < 2) continue;
    if (upper.includes(needle)) return n;
  }
  return null;
}

export function flattenStringValues(
  obj: Record<string, unknown>,
  maxDepth = 2,
): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > maxDepth) return;
    if (typeof v === "string") {
      parts.push(v);
      return;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      parts.push(String(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 40)) walk(item, depth + 1);
      return;
    }
    const rec = asRecord(v);
    if (rec) {
      for (const [k, val] of Object.entries(rec).slice(0, 80)) {
        parts.push(k);
        walk(val, depth + 1);
      }
    }
  };
  walk(obj, 0);
  return parts.join(" ");
}
