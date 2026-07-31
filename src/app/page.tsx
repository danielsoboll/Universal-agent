import { redirect } from "next/navigation";
import {
  getLocalAuthContext,
  roleHomePath,
} from "@/lib/localAuth/session";

export default async function HomePage() {
  const ctx = await getLocalAuthContext();
  if (!ctx) redirect("/login");
  redirect(roleHomePath(ctx.user.role));
}
