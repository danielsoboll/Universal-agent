"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function createProject(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) {
    throw new Error("Name ist erforderlich.");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Nicht angemeldet.");
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({
      name,
      description: description || null,
      owner_id: user.id,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/");
  redirect(`/projects/${data.id}`);
}

export async function getMyProjects() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, description, status, owner_id, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function getProjectAccess(projectId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, name, description, status, owner_id, created_at, updated_at")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError || !project) {
    return null;
  }

  const { data: membership } = await supabase
    .from("project_members")
    .select("role, is_active")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!membership) {
    return null;
  }

  return {
    project,
    role: membership.role as "owner" | "editor" | "viewer",
    userId: user.id,
  };
}
