import { existsSync, readFileSync, writeFileSync } from "fs";
import { appConfigPath, newId } from "@/lib/localAuth/crypto";
import type { LocalProject } from "@/lib/localAuth/types";

export interface ProjectRepository {
  list(): Promise<LocalProject[]>;
  getById(id: string): Promise<LocalProject | null>;
  upsert(project: Omit<LocalProject, "created_at" | "updated_at"> & Partial<Pick<LocalProject, "created_at" | "updated_at">>): Promise<LocalProject>;
}

function filePath() {
  return appConfigPath("projects.json");
}

function readAll(): LocalProject[] {
  const p = filePath();
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8")) as LocalProject[];
  return Array.isArray(raw) ? raw : [];
}

function writeAll(rows: LocalProject[]) {
  writeFileSync(filePath(), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

export const fileProjectRepository: ProjectRepository = {
  async list() {
    return readAll();
  },
  async getById(id) {
    return readAll().find((p) => p.id === id) ?? null;
  },
  async upsert(input) {
    const now = new Date().toISOString();
    const rows = readAll();
    const idx = rows.findIndex((p) => p.id === input.id);
    const next: LocalProject = {
      id: input.id || newId("proj"),
      name: input.name,
      description: input.description,
      customer_id: input.customer_id,
      system_id: input.system_id,
      local_data_root: input.local_data_root,
      active_index_path: input.active_index_path,
      enabled_knowledge_unit_types: input.enabled_knowledge_unit_types ?? [],
      created_at: input.created_at ?? now,
      updated_at: now,
    };
    if (idx >= 0) {
      next.created_at = rows[idx]!.created_at;
      rows[idx] = next;
    } else {
      rows.push(next);
    }
    writeAll(rows);
    return next;
  },
};
