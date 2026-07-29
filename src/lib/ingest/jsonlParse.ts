import { createHash } from "crypto";

export type JsonlLineError = {
  lineNumber: number;
  raw: string;
  error: string;
};

export type JsonlParsedRecord = {
  lineNumber: number;
  raw: string;
  /** Parsed object when line was valid JSON object/array/primitive JSON */
  value: unknown;
};

export type JsonlParseResult = {
  linesRead: number;
  records: JsonlParsedRecord[];
  errors: JsonlLineError[];
};

/**
 * Parse JSONL text line-by-line.
 * Empty/whitespace lines are counted as read but skipped (not errors, not records).
 * Invalid JSON lines are recorded in errors; processing continues.
 * Original line text is always preserved on records/errors.
 */
export function parseJsonlText(text: string): JsonlParseResult {
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  const records: JsonlParsedRecord[] = [];
  const errors: JsonlLineError[] = [];

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    if (raw.trim() === "") {
      return;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      records.push({ lineNumber, raw, value });
    } catch (error) {
      errors.push({
        lineNumber,
        raw,
        error: error instanceof Error ? error.message : "JSON ungültig",
      });
    }
  });

  return {
    linesRead: lines.length,
    records,
    errors,
  };
}

export function parseTxtAsLineRecords(text: string): JsonlParseResult {
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  const records: JsonlParsedRecord[] = [];

  lines.forEach((raw, index) => {
    if (raw.trim() === "") return;
    records.push({
      lineNumber: index + 1,
      raw,
      value: { text: raw },
    });
  });

  return {
    linesRead: lines.length,
    records,
    errors: [],
  };
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
