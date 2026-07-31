import { existsSync, readFileSync, writeFileSync } from "fs";
import { appConfigPath, newId } from "@/lib/localAuth/crypto";
import { SESSION_TTL_MS } from "@/lib/localAuth/sessionToken";
import type { LocalSession, LocalUser } from "@/lib/localAuth/types";

export interface SessionRepository {
  create(user: LocalUser): Promise<LocalSession>;
  getById(id: string): Promise<LocalSession | null>;
  delete(id: string): Promise<void>;
  purgeExpired(): Promise<void>;
}

function filePath() {
  return appConfigPath("sessions.json");
}

function readAll(): LocalSession[] {
  const p = filePath();
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8")) as LocalSession[];
  return Array.isArray(raw) ? raw : [];
}

function writeAll(rows: LocalSession[]) {
  writeFileSync(filePath(), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

export const fileSessionRepository: SessionRepository = {
  async create(user) {
    const now = Date.now();
    const session: LocalSession = {
      id: newId("sess"),
      user_id: user.id,
      role: user.role,
      project_ids: user.project_ids,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    const rows = readAll().filter((s) => Date.parse(s.expires_at) > now);
    rows.push(session);
    writeAll(rows);
    return session;
  },
  async getById(id) {
    const s = readAll().find((x) => x.id === id);
    if (!s) return null;
    if (Date.parse(s.expires_at) <= Date.now()) {
      await this.delete(id);
      return null;
    }
    return s;
  },
  async delete(id) {
    writeAll(readAll().filter((s) => s.id !== id));
  },
  async purgeExpired() {
    const now = Date.now();
    writeAll(readAll().filter((s) => Date.parse(s.expires_at) > now));
  },
};
