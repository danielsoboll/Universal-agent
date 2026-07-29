"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function createChatSession(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "Neuer Chat").trim() || "Neuer Chat";

  if (!projectId) {
    throw new Error("Projekt fehlt.");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Nicht angemeldet.");
  }

  const { error } = await supabase.from("chat_sessions").insert({
    project_id: projectId,
    title,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath(`/projects/${projectId}`);
}

export async function saveUserChatMessage(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const sessionId = String(formData.get("sessionId") ?? "");
  const content = String(formData.get("content") ?? "").trim();

  if (!projectId || !sessionId || !content) {
    throw new Error("Projekt, Session oder Inhalt fehlt.");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Nicht angemeldet.");
  }

  const { error } = await supabase.from("chat_messages").insert({
    project_id: projectId,
    chat_session_id: sessionId,
    role: "user",
    content,
    metadata: { user_id: user.id },
  });

  if (error) {
    throw new Error(error.message);
  }

  try {
    const admin = createAdminClient();
    await admin.from("chat_messages").insert({
      project_id: projectId,
      chat_session_id: sessionId,
      role: "assistant",
      content:
        "Nachricht gespeichert. KI-Antworten folgen in einer späteren Phase.",
      metadata: { placeholder: true },
    });
  } catch {
    // ignore if admin unavailable
  }

  revalidatePath(`/projects/${projectId}`);
}
