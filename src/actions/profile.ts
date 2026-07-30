"use server";

import { revalidatePath } from "next/cache";
import { requireUser, setActiveModuleForUser } from "@/lib/onboarding/access";
import type { AppModuleKey } from "@/lib/onboarding/appProfileTypes";

export async function switchActiveModuleAction(formData: FormData) {
  const ctx = await requireUser();
  const moduleKey = String(formData.get("module") ?? "") as AppModuleKey;
  if (!["general", "sap", "homepage", "database"].includes(moduleKey)) {
    throw new Error("Ungültiges Modul");
  }
  const result = await setActiveModuleForUser(ctx.userId, moduleKey);
  if (!result.ok) throw new Error(result.error ?? "Modulwechsel fehlgeschlagen");
  revalidatePath("/");
  revalidatePath("/admin", "layout");
  revalidatePath("/app", "layout");
}
