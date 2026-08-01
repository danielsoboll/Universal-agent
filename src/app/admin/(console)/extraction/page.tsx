import { redirect } from "next/navigation";

/** Legacy Datenimport route → Hauptschritt Validierung. */
export default async function ExtractionRebuildRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; customer?: string }>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.customer?.trim()) qs.set("customer", sp.customer.trim());
  if (sp.project?.trim()) qs.set("project", sp.project.trim());
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  redirect(`/admin/steps/4${suffix}`);
}
