import { redirect } from "next/navigation";
import { requireAdminAccess } from "@/lib/onboarding/access";

/** Früher lokale Projektseite — auf Vercel über Setup/Dashboard. */
export default async function AdminProjectPage() {
  await requireAdminAccess();
  redirect("/admin/setup");
}
