"use server";

import { redirect } from "next/navigation";
import { verifyPassword } from "@/lib/localAuth/crypto";
import {
  clearLocalSessionCookie,
  roleHomePath,
  setLocalSessionCookie,
} from "@/lib/localAuth/session";
import { fileSessionRepository } from "@/lib/localAuth/sessionRepository";
import { fileUserRepository } from "@/lib/localAuth/userRepository";

export async function localSignIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const nextRaw = String(formData.get("next") ?? "").trim();

  if (!email || !password) {
    redirect(
      `/login?error=${encodeURIComponent("E-Mail und Passwort sind erforderlich.")}`,
    );
  }

  const user = await fileUserRepository.getByEmail(email);
  if (!user || !user.enabled) {
    redirect(
      `/login?error=${encodeURIComponent("Anmeldung fehlgeschlagen. Konto unbekannt oder deaktiviert.")}`,
    );
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    redirect(
      `/login?error=${encodeURIComponent("Anmeldung fehlgeschlagen. E-Mail oder Passwort ungültig.")}`,
    );
  }

  const session = await fileSessionRepository.create(user);
  await setLocalSessionCookie(session);

  if (
    nextRaw.startsWith("/") &&
    !nextRaw.startsWith("//") &&
    !(user.role === "user" && nextRaw.startsWith("/admin"))
  ) {
    redirect(nextRaw);
  }
  redirect(roleHomePath(user.role));
}

export async function localSignOut() {
  const { getLocalAuthContext } = await import("@/lib/localAuth/session");
  const ctx = await getLocalAuthContext();
  if (ctx) {
    await fileSessionRepository.delete(ctx.session.id);
  }
  await clearLocalSessionCookie();
  redirect("/login");
}
