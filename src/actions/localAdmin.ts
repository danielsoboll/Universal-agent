"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { hashPassword, newId } from "@/lib/localAuth/crypto";
import { requireLocalAdmin } from "@/lib/localAuth/session";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { fileUserRepository } from "@/lib/localAuth/userRepository";
import { KnowledgeRetriever } from "@/lib/knowledge/knowledgeRetriever";
import type { LocalRole } from "@/lib/localAuth/types";

function adminError(path: string, message: string) {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function saveLocalProjectAction(formData: FormData) {
  await requireLocalAdmin();
  const id = String(formData.get("id") ?? "").trim() || newId("proj");
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const customer_id = String(formData.get("customer_id") ?? "").trim();
  const system_id = String(formData.get("system_id") ?? "").trim();
  const local_data_root = String(formData.get("local_data_root") ?? "").trim();
  const active_index_path =
    String(formData.get("active_index_path") ?? "").trim() || "indexes/search";
  const typesRaw = String(formData.get("enabled_knowledge_unit_types") ?? "").trim();
  const enabled_knowledge_unit_types = typesRaw
    ? typesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  if (!name || !customer_id || !system_id) {
    adminError(
      "/admin/project",
      "Name, Customer-ID und System-ID sind erforderlich.",
    );
  }

  const project = await fileProjectRepository.upsert({
    id,
    name,
    description,
    customer_id,
    system_id,
    local_data_root,
    active_index_path,
    enabled_knowledge_unit_types,
  });

  const check = KnowledgeRetriever.inspect(project);
  revalidatePath("/admin");
  revalidatePath("/admin/project");
  redirect(
    `/admin/project?saved=1&status=${encodeURIComponent(check.message)}`,
  );
}

export async function createLocalUserAction(formData: FormData) {
  await requireLocalAdmin();
  const display_name = String(formData.get("display_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "user").trim() as LocalRole;
  const project_id = String(formData.get("project_id") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const enabled = String(formData.get("enabled") ?? "true") === "true";

  if (!display_name || !email || !password || password.length < 8) {
    adminError(
      "/admin/users",
      "Name, E-Mail und Passwort (mind. 8 Zeichen) sind erforderlich.",
    );
  }
  if (role !== "admin" && role !== "user") {
    adminError("/admin/users", "Ungültige Rolle.");
  }
  if (!project_id) {
    adminError("/admin/users", "Projektzuordnung ist erforderlich.");
  }
  const project = await fileProjectRepository.getById(project_id);
  if (!project) adminError("/admin/users", "Projekt nicht gefunden.");

  const existing = await fileUserRepository.getByEmail(email);
  if (existing) {
    adminError("/admin/users", "E-Mail ist bereits vergeben.");
  }

  const password_hash = await hashPassword(password);
  await fileUserRepository.upsert({
    id: newId("user"),
    email,
    display_name,
    role,
    project_ids: [project_id],
    password_hash,
    enabled,
  });

  revalidatePath("/admin/users");
  redirect("/admin/users?saved=1");
}
