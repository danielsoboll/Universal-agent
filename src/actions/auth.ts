"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function resolvePostLoginPath(userId: string): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("app_user_profiles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    if (profile?.role === "general_admin" || profile?.role === "admin") {
      return "/";
    }
    if (profile?.role === "user") return "/";

    const { data: platform } = await admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (platform) return "/";

    const { data: membership } = await admin
      .from("customer_memberships")
      .select("role")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (membership?.role === "customer_admin") return "/";
    if (membership) return "/";
  } catch {
    /* Schema fehlt */
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
    // Kein Signup — nur bestehende Auth-Nutzer
    redirect(
      `/login?error=${encodeURIComponent(
        "Anmeldung fehlgeschlagen. Benutzername oder Passwort ungültig. Ein Konto kann hier nicht angelegt werden.",
      )}`,
    );
  }

  if (nextRaw.startsWith("/") && !nextRaw.startsWith("//")) {
    redirect(nextRaw);
  }

  redirect(await resolvePostLoginPath(data.user.id));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
