import { existsSync, readFileSync, writeFileSync } from "fs";
import { appConfigPath, newId } from "@/lib/localAuth/crypto";
import type { AskHistoryEntry } from "@/lib/localAuth/types";

export interface HistoryRepository {
  add(entry: Omit<AskHistoryEntry, "id" | "created_at">): Promise<AskHistoryEntry>;
  listForUser(userId: string, projectId?: string): Promise<AskHistoryEntry[]>;
  listForProject(projectId: string): Promise<AskHistoryEntry[]>;
}

function filePath() {
  return appConfigPath("ask_history.json");
}

function readAll(): AskHistoryEntry[] {
  const p = filePath();
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8")) as AskHistoryEntry[];
  return Array.isArray(raw) ? raw : [];
}

function writeAll(rows: AskHistoryEntry[]) {
  writeFileSync(filePath(), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

export const fileHistoryRepository: HistoryRepository = {
  async add(input) {
    const entry: AskHistoryEntry = {
      ...input,
      id: newId("ask"),
      created_at: new Date().toISOString(),
    };
    const rows = readAll();
    rows.unshift(entry);
    writeAll(rows.slice(0, 500));
    return entry;
  },
  async listForUser(userId, projectId) {
    return readAll().filter(
      (e) =>
        e.user_id === userId &&
        (!projectId || e.project_id === projectId),
    );
  },
  async listForProject(projectId) {
    return readAll().filter((e) => e.project_id === projectId);
  },
};
