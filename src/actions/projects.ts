"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type CreateProjectState = {
  error: string | null;
};

function formatSupabaseError(error: {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}): string {
  const parts = [error.message];
  if (error.code) parts.push(`Code: ${error.code}`);
  if (error.details) parts.push(error.details);
  if (error.hint) parts.push(`Hinweis: ${error.hint}`);
  return parts.join(" · ");
}

export async function createProject(
  _prev: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) {
    return { error: "Bitte einen Projektnamen angeben." };
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) {
    console.error("[createProject] auth.getUser failed", {
      message: authError.message,
      status: authError.status,
      name: authError.name,
    });
    return { error: "Anmeldung konnte nicht geprüft werden. Bitte erneut einloggen." };
  }

  if (!user) {
    console.error("[createProject] not authenticated");
    return { error: "Nicht angemeldet. Bitte einloggen und erneut versuchen." };
  }

  console.info("[createProject] inserting", {
    userId: user.id,
    name,
  });

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
    console.error("[createProject] insert failed", {
      userId: user.id,
      name,
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    return {
      error: `Projekt konnte nicht angelegt werden. ${formatSupabaseError(error)}`,
    };
  }

  if (!data?.id) {
    console.error("[createProject] insert returned no id", { userId: user.id, name });
    return { error: "Projekt wurde angelegt, aber die ID fehlt. Bitte Seite neu laden." };
  }

  console.info("[createProject] success", {
    userId: user.id,
    projectId: data.id,
  });

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
    console.error("[getMyProjects] failed", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
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

  if (projectError) {
    console.error("[getProjectAccess] project select failed", {
      projectId,
      message: projectError.message,
      code: projectError.code,
      details: projectError.details,
      hint: projectError.hint,
    });
    return null;
  }

  if (!project) {
    return null;
  }

  const { data: membership, error: membershipError } = await supabase
    .from("project_members")
    .select("role, is_active")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (membershipError) {
    console.error("[getProjectAccess] membership select failed", {
      projectId,
      userId: user.id,
      message: membershipError.message,
      code: membershipError.code,
      details: membershipError.details,
      hint: membershipError.hint,
    });
    return null;
  }

  if (!membership) {
    return null;
  }

  return {
    project,
    role: membership.role as "owner" | "editor" | "viewer",
    userId: user.id,
  };
}
