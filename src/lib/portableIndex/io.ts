import { createHash } from "crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from "fs";
import path from "path";
import * as readline from "readline";
import type { PortableSourceStamp } from "@/lib/portableIndex/types";

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stream-hash a file without loading it fully into RAM. */
export async function hashFileStreaming(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function stampRelativeSource(params: {
  absolutePath: string;
  relativePath: string;
  contentHash: string;
}): PortableSourceStamp | null {
  if (!existsSync(params.absolutePath)) return null;
  const st = statSync(params.absolutePath);
  if (!st.isFile()) return null;
  return {
    relative_path: params.relativePath.replace(/\\/g, "/"),
    mtime_ms: st.mtimeMs,
    size: st.size,
    content_hash: params.contentHash,
  };
}

export function sourcesFingerprint(sources: PortableSourceStamp[]): string {
  const payload = sources
    .map(
      (s) =>
        `${s.relative_path}|${s.mtime_ms}|${s.size}|${s.content_hash}`,
    )
    .sort()
    .join("\n");
  return hashText(payload);
}

/** Write via temp file + rename (atomic on same filesystem). */
export function atomicWriteText(absPath: string, content: string): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, absPath);
}

export type JsonlWriter = {
  write: (obj: unknown) => void;
  end: () => Promise<void>;
  path: string;
};

/** Streaming JSONL writer → temp, then rename on end. */
export function createAtomicJsonlWriter(absPath: string): JsonlWriter {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  const stream: WriteStream = createWriteStream(tmp, { encoding: "utf8" });
  return {
    path: absPath,
    write(obj: unknown) {
      stream.write(`${JSON.stringify(obj)}\n`);
    },
    end() {
      return new Promise((resolve, reject) => {
        stream.end(() => {
          try {
            renameSync(tmp, absPath);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        stream.on("error", reject);
      });
    },
  };
}

export async function forEachJsonlLine(
  absPath: string,
  onLine: (line: string, index: number) => void | Promise<void>,
): Promise<number> {
  if (!existsSync(absPath)) return 0;
  const rl = readline.createInterface({
    input: createReadStream(absPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let i = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    await onLine(line, i);
    i += 1;
  }
  return i;
}

export function rmQuiet(absPath: string): void {
  try {
    rmSync(absPath, { force: true });
  } catch {
    // ignore
  }
}
