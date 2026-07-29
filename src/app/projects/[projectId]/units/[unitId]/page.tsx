import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { getProjectAccess } from "@/actions/projects";
import { createClient } from "@/lib/supabase/server";

export default async function KnowledgeUnitDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; unitId: string }>;
}) {
  const { projectId, unitId } = await params;
  const access = await getProjectAccess(projectId);
  if (!access) notFound();

  const supabase = await createClient();
  const { data: unit } = await supabase
    .from("knowledge_units")
    .select(
      "id, title, unit_type, original_content, prepared_content, metadata, source_location, processing_status, created_at, source_id, document_id",
    )
    .eq("project_id", projectId)
    .eq("id", unitId)
    .maybeSingle();

  if (!unit) notFound();

  const technical =
    unit.metadata &&
    typeof unit.metadata === "object" &&
    "technical_fields" in unit.metadata
      ? (unit.metadata as { technical_fields?: Record<string, string> })
          .technical_fields
      : null;

  return (
    <>
      <AppHeader roleLabel={access.role} />
      <main className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
        <Link href={`/projects/${projectId}`} className="muted text-sm">
          ← Zurück zum Projekt
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {unit.title || "Knowledge Unit"}
          </h1>
          <p className="muted mt-1 text-sm">
            {unit.unit_type} · {unit.processing_status}
          </p>
        </div>

        <section className="panel p-5">
          <h2 className="text-lg font-semibold">Originaltext</h2>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-[#f8fafc] p-3 text-sm">
            {unit.original_content || "—"}
          </pre>
        </section>

        <section className="panel p-5">
          <h2 className="text-lg font-semibold">Vorbereiteter Inhalt</h2>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-[#f8fafc] p-3 text-sm">
            {unit.prepared_content || "—"}
          </pre>
        </section>

        <section className="panel p-5">
          <h2 className="text-lg font-semibold">Technische Metadaten</h2>
          {technical && Object.keys(technical).length > 0 ? (
            <dl className="mt-3 grid gap-2 text-sm">
              {Object.entries(technical).map(([key, value]) => (
                <div key={key}>
                  <dt className="muted">{key}</dt>
                  <dd className="font-mono text-xs whitespace-pre-wrap">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted mt-2 text-sm">Keine technischen Felder erkannt.</p>
          )}
          <h3 className="mt-4 text-sm font-semibold">source_location</h3>
          <pre className="mt-2 overflow-x-auto rounded-md bg-[#f8fafc] p-3 text-xs">
            {JSON.stringify(unit.source_location ?? {}, null, 2)}
          </pre>
        </section>
      </main>
    </>
  );
}
