import { existsSync, readFileSync, writeFileSync } from "fs";
import { appConfigPath, newId } from "@/lib/localAuth/crypto";
import type { LocalUser } from "@/lib/localAuth/types";

export interface UserRepository {
  list(): Promise<LocalUser[]>;
  getById(id: string): Promise<LocalUser | null>;
  getByEmail(email: string): Promise<LocalUser | null>;
  upsert(user: Omit<LocalUser, "created_at" | "updated_at"> & Partial<Pick<LocalUser, "created_at" | "updated_at">>): Promise<LocalUser>;
}

function filePath() {
  return appConfigPath("users.json");
}

function readAll(): LocalUser[] {
  const p = filePath();
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8")) as LocalUser[];
  return Array.isArray(raw) ? raw : [];
}

function writeAll(rows: LocalUser[]) {
  writeFileSync(filePath(), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

export const fileUserRepository: UserRepository = {
  async list() {
    return readAll();
  },
  async getById(id) {
    return readAll().find((u) => u.id === id) ?? null;
  },
  async getByEmail(email) {
    const needle = email.trim().toLowerCase();
    return readAll().find((u) => u.email === needle) ?? null;
  },
  async upsert(input) {
    const now = new Date().toISOString();
    const rows = readAll();
    const email = input.email.trim().toLowerCase();
    const idx = rows.findIndex((u) => u.id === input.id || u.email === email);
    const next: LocalUser = {
      id: input.id || newId("user"),
      email,
      display_name: input.display_name,
      role: input.role,
      project_ids: input.project_ids,
      password_hash: input.password_hash,
      enabled: input.enabled,
      created_at: input.created_at ?? now,
      updated_at: now,
    };
    if (idx >= 0) {
      next.id = rows[idx]!.id;
      next.created_at = rows[idx]!.created_at;
      if (!input.password_hash) next.password_hash = rows[idx]!.password_hash;
      rows[idx] = next;
    } else {
      rows.push(next);
    }
    writeAll(rows);
    return next;
  },
};
