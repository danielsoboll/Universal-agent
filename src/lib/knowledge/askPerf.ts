/**
 * Ask-path performance instrumentation (measurement only — no architecture change).
 * Uses AsyncLocalStorage so nested retrieval/FS can attach to the active request.
 */
import { AsyncLocalStorage } from "async_hooks";
import { existsSync, readFileSync, statSync } from "fs";

export type AskPerfFsRead = {
  path: string;
  bytes: number;
  read_ms: number;
  parse_ms: number;
  kind: string;
  cache_hit: boolean;
};

export type AskPerfPhase = {
  name: string;
  started_ms: number;
  ended_ms: number | null;
  duration_ms: number | null;
};

export type AskPerfReport = {
  request_id: string;
  question: string;
  cold_or_warm: "cold" | "warm" | "unknown";
  total_ms: number;
  phases: Array<{ name: string; duration_ms: number; started_ms: number }>;
  fs_reads: AskPerfFsRead[];
  fs_bytes_total: number;
  fs_read_ms_total: number;
  fs_parse_ms_total: number;
  openai_calls: number;
  openai_ms_total: number;
  index_rebuilt: boolean;
  index_loaded_from_disk: boolean;
  lexical_corpus_cache_hit: boolean | null;
  notes: string[];
  node_env: string;
  /** Absolute timeline from request enter (ms). */
  marks: Record<string, number>;
};

type Store = {
  request_id: string;
  question: string;
  cold_or_warm: "cold" | "warm" | "unknown";
  t0: number;
  marks: Map<string, number>;
  openPhases: Map<string, number>;
  phases: AskPerfPhase[];
  fs_reads: AskPerfFsRead[];
  openai_calls: number;
  openai_ms_total: number;
  index_rebuilt: boolean;
  index_loaded_from_disk: boolean;
  lexical_corpus_cache_hit: boolean | null;
  notes: string[];
};

const als = new AsyncLocalStorage<Store>();

let warmSeenQuestions = new Set<string>();

function now(): number {
  return performance.now();
}

function getStore(): Store | undefined {
  return als.getStore();
}

export function runWithAskPerf<T>(
  params: {
    question: string;
    requestId?: string;
    forceCold?: boolean;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const q = params.question.trim();
  const cold =
    params.forceCold === true
      ? true
      : params.forceCold === false
        ? false
        : !warmSeenQuestions.has(q.toLowerCase());
  const store: Store = {
    request_id: params.requestId ?? `ask_${Date.now().toString(36)}`,
    question: q,
    cold_or_warm: cold ? "cold" : "warm",
    t0: now(),
    marks: new Map([["api_route_entered", 0]]),
    openPhases: new Map(),
    phases: [],
    fs_reads: [],
    openai_calls: 0,
    openai_ms_total: 0,
    index_rebuilt: false,
    index_loaded_from_disk: false,
    lexical_corpus_cache_hit: null,
    notes: [],
  };
  return als.run(store, async () => {
    try {
      return await fn();
    } finally {
      warmSeenQuestions.add(q.toLowerCase());
    }
  });
}

export function askPerfMark(name: string): void {
  const s = getStore();
  if (!s) return;
  s.marks.set(name, now() - s.t0);
}

export function askPerfBegin(name: string): void {
  const s = getStore();
  if (!s) return;
  s.openPhases.set(name, now());
  if (!s.marks.has(name + "_start")) {
    s.marks.set(name + "_start", now() - s.t0);
  }
}

export function askPerfEnd(name: string): void {
  const s = getStore();
  if (!s) return;
  const start = s.openPhases.get(name);
  const end = now();
  if (start == null) {
    s.notes.push(`askPerfEnd without begin: ${name}`);
    return;
  }
  s.openPhases.delete(name);
  const duration = end - start;
  s.phases.push({
    name,
    started_ms: start - s.t0,
    ended_ms: end - s.t0,
    duration_ms: duration,
  });
  s.marks.set(name + "_end", end - s.t0);
  s.marks.set(name + "_ms", duration);
}

export function askPerfNote(note: string): void {
  const s = getStore();
  if (!s) return;
  s.notes.push(note);
}

export function askPerfRecordOpenAi(durationMs: number): void {
  const s = getStore();
  if (!s) return;
  s.openai_calls += 1;
  s.openai_ms_total += durationMs;
}

export function askPerfSetLexicalCacheHit(hit: boolean): void {
  const s = getStore();
  if (!s) return;
  s.lexical_corpus_cache_hit = hit;
}

export function askPerfSetIndexLoaded(fromDisk: boolean, rebuilt: boolean): void {
  const s = getStore();
  if (!s) return;
  s.index_loaded_from_disk = fromDisk;
  s.index_rebuilt = rebuilt;
}

export function askPerfTrackedReadFile(
  absPath: string,
  kind: string,
  opts?: { parse?: (raw: string) => unknown; cacheHit?: boolean },
): { raw: string; parsed: unknown | null; bytes: number } {
  const cacheHit = Boolean(opts?.cacheHit);
  const tRead0 = now();
  let raw = "";
  let bytes = 0;
  if (!cacheHit) {
    if (existsSync(absPath)) {
      try {
        bytes = statSync(absPath).size;
      } catch {
        bytes = 0;
      }
      raw = readFileSync(absPath, "utf8");
      if (!bytes) bytes = Buffer.byteLength(raw, "utf8");
    }
  }
  const read_ms = now() - tRead0;
  let parsed: unknown | null = null;
  let parse_ms = 0;
  if (opts?.parse && raw) {
    const tParse0 = now();
    parsed = opts.parse(raw);
    parse_ms = now() - tParse0;
  }
  const s = getStore();
  if (s) {
    s.fs_reads.push({
      path: absPath,
      bytes,
      read_ms,
      parse_ms,
      kind,
      cache_hit: cacheHit,
    });
  }
  return { raw, parsed, bytes };
}

export function getAskPerfReport(): AskPerfReport | null {
  const s = getStore();
  if (!s) return null;
  const total_ms = now() - s.t0;
  // Close dangling phases
  for (const [name] of s.openPhases) {
    askPerfEnd(name);
  }
  const phases = s.phases
    .filter((p) => p.duration_ms != null)
    .map((p) => ({
      name: p.name,
      duration_ms: Math.round((p.duration_ms ?? 0) * 10) / 10,
      started_ms: Math.round(p.started_ms * 10) / 10,
    }));
  const marks: Record<string, number> = {};
  for (const [k, v] of s.marks) {
    marks[k] = Math.round(v * 10) / 10;
  }
  return {
    request_id: s.request_id,
    question: s.question,
    cold_or_warm: s.cold_or_warm,
    total_ms: Math.round(total_ms * 10) / 10,
    phases,
    fs_reads: s.fs_reads.map((r) => ({
      ...r,
      read_ms: Math.round(r.read_ms * 10) / 10,
      parse_ms: Math.round(r.parse_ms * 10) / 10,
    })),
    fs_bytes_total: s.fs_reads.reduce((a, r) => a + (r.cache_hit ? 0 : r.bytes), 0),
    fs_read_ms_total:
      Math.round(s.fs_reads.reduce((a, r) => a + r.read_ms, 0) * 10) / 10,
    fs_parse_ms_total:
      Math.round(s.fs_reads.reduce((a, r) => a + r.parse_ms, 0) * 10) / 10,
    openai_calls: s.openai_calls,
    openai_ms_total: Math.round(s.openai_ms_total * 10) / 10,
    index_rebuilt: s.index_rebuilt,
    index_loaded_from_disk: s.index_loaded_from_disk,
    lexical_corpus_cache_hit: s.lexical_corpus_cache_hit,
    notes: [...s.notes],
    node_env: process.env.NODE_ENV ?? "unknown",
    marks,
  };
}

/** Reset warm-question tracking (for cold measurement scripts). */
export function resetAskPerfWarmState(): void {
  warmSeenQuestions = new Set();
}

export function formatServerTiming(report: AskPerfReport): string {
  const parts = report.phases
    .slice(0, 12)
    .map((p) => {
      const key = p.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      return `${key};dur=${p.duration_ms.toFixed(1)}`;
    });
  parts.push(`total;dur=${report.total_ms.toFixed(1)}`);
  return parts.join(", ");
}
