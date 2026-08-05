"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

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

  // First screen for every role — navigate to dashboard/app from there.
  redirect("/");
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
