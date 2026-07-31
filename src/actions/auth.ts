"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  canAccessAdmin,
  canAccessApp,
  getAccessContext,
} from "@/lib/onboarding/access";

function safeNextPath(raw: string): string | null {
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return null;
}

async function resolvePostLoginPath(): Promise<string> {
  try {
    const ctx = await getAccessContext();
    if (!ctx) return "/";
    if (canAccessAdmin(ctx)) return "/admin/dashboard";
    if (canAccessApp(ctx)) return "/app/ask";
  } catch {
    /* Schema/Profil noch nicht verfügbar */
  }
  return "/";
}

export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const nextRaw = String(formData.get("next") ?? "").trim();

  if (!email || !password) {
    redirect(
      `/login?error=${encodeURIComponent("Benutzername und Passwort sind erforderlich.")}`,
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    redirect(
      `/login?error=${encodeURIComponent(
        "Anmeldung fehlgeschlagen. Benutzername oder Passwort ungültig. Ein Konto kann hier nicht angelegt werden.",
      )}`,
    );
  }

  const next = safeNextPath(nextRaw);
  if (next && next !== "/login") {
    redirect(next);
  }

  redirect(await resolvePostLoginPath());
}

/** Fallback — bevorzugter Logout: POST /auth/signout */
export async function signOut() {
  const supabase = await createClient();
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    console.error("[auth] signOut", error);
  }
  redirect("/login");
}
