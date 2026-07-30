"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, setActiveModuleForUser } from "@/lib/onboarding/access";
import type { AppModuleKey } from "@/lib/onboarding/appProfileTypes";

export async function switchActiveModuleAction(formData: FormData) {
  const ctx = await requireUser();
  const moduleKey = String(formData.get("module") ?? "") as AppModuleKey;
  if (!["general", "sap", "homepage", "database"].includes(moduleKey)) {
    console.error("[profile] invalid module", moduleKey);
    redirect(`/?error=${encodeURIComponent("Ungültiges Modul.")}`);
  }
  const result = await setActiveModuleForUser(ctx.userId, moduleKey);
  if (!result.ok) {
    console.error("[profile] module switch failed", result.error);
    redirect(
      `/?error=${encodeURIComponent(
        "Modulwechsel nicht möglich. Bitte erneut versuchen.",
      )}`,
    );
  }
  revalidatePath("/");
  revalidatePath("/admin", "layout");
  revalidatePath("/app", "layout");
}
