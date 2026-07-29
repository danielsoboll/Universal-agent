import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { SourceUploadForm } from "@/components/SourceUploadForm";
import { getProjectAccess } from "@/actions/projects";
import { createClient } from "@/lib/supabase/server";
import { createChatSession, saveUserChatMessage } from "@/actions/chat";
import { formatBytes } from "@/lib/sourceUpload";

function formatDateTime(iso: string) {
  try {
    return new Intl.DateTimeFormat("de-DE", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Europe/Berlin",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

type IngestMeta = {
  lines_read?: number;
  valid_records?: number;
  invalid_lines?: number;
  documents_created?: number;
  knowledge_units_created?: number;
};

function readIngestMeta(metadata: unknown): IngestMeta | null {
  if (!metadata || typeof metadata !== "object") return null;
  const ingest = (metadata as { ingest?: unknown }).ingest;
  if (!ingest || typeof ingest !== "object") return null;
  return ingest as IngestMeta;
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const access = await getProjectAccess(projectId);
  if (!access) {
    notFound();
  }

  const { project, role } = access;
  const canEdit = role === "owner" || role === "editor";
  const supabase = await createClient();

  const [
    { data: sources },
    { data: jobs },
    { data: sessions },
    { data: units },
    { count: unitCount },
    { count: documentCount },
  ] = await Promise.all([
    supabase
      .from("sources")
      .select(
        "id, name, source_type, original_filename, mime_type, file_size, storage_path, storage_bucket, processing_status, processing_error, metadata, created_at",
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
    supabase
      .from("processing_jobs")
      .select("id, source_id, job_type, status, result, error, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("chat_sessions")
      .select("id, title, created_at")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("knowledge_units")
      .select(
        "id, title, unit_type, processing_status, source_location, created_at, metadata",
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("knowledge_units")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId),
    supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId),
  ]);

  const latestSession = sessions?.[0] ?? null;
  const { data: messages } = latestSession
    ? await supabase
        .from("chat_messages")
        .select("id, role, content, created_at")
        .eq("chat_session_id", latestSession.id)
        .order("created_at", { ascending: true })
    : { data: [] };

  const totals = (sources ?? []).reduce(
    (acc, source) => {
      const ingest = readIngestMeta(source.metadata);
      if (!ingest) return acc;
      acc.linesRead += ingest.lines_read ?? 0;
      acc.valid += ingest.valid_records ?? 0;
      acc.invalid += ingest.invalid_lines ?? 0;
      return acc;
    },
    { linesRead: 0, valid: 0, invalid: 0 },
  );

  return (
    <>
      <AppHeader roleLabel={role} />
      <main className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
        <div>
          <Link href="/" className="muted text-sm">
            ← Projekte
          </Link>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">
                {project.name}
              </h1>
              {project.description ? (
                <p className="muted mt-1">{project.description}</p>
              ) : null}
            </div>
            <span className="badge">Rolle: {role}</span>
          </div>
        </div>

        <section className="panel p-6">
          <h2 className="text-xl font-semibold">Verarbeitungsübersicht</h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="muted">Gelesene Zeilen</dt>
              <dd className="font-medium">{totals.linesRead}</dd>
            </div>
            <div>
              <dt className="muted">Gültige Datensätze</dt>
              <dd className="font-medium">{totals.valid}</dd>
            </div>
            <div>
              <dt className="muted">Fehlerhafte Zeilen</dt>
              <dd className="font-medium">{totals.invalid}</dd>
            </div>
            <div>
              <dt className="muted">Dokumente</dt>
              <dd className="font-medium">{documentCount ?? 0}</dd>
            </div>
            <div>
              <dt className="muted">Knowledge Units</dt>
              <dd className="font-medium">{unitCount ?? 0}</dd>
            </div>
          </dl>
        </section>

        <section className="panel p-6">
          <h2 className="text-xl font-semibold">Quellen</h2>
          {canEdit ? (
            <SourceUploadForm projectId={projectId} />
          ) : (
            <p className="muted mt-2 text-sm">
              Viewer können Quellen nur lesen.
            </p>
          )}

          <ul className="mt-6 divide-y divide-[var(--border)]">
            {(sources ?? []).length === 0 ? (
              <li className="muted py-3 text-sm">Keine Quellen.</li>
            ) : (
              (sources ?? []).map((source) => {
                const ingest = readIngestMeta(source.metadata);
                return (
                  <li key={source.id} className="py-3">
                    <p className="font-medium">
                      {source.original_filename || source.name}
                    </p>
                    <p className="muted mt-1 text-xs">
                      Typ: {source.source_type}
                      {" · "}
                      Größe: {formatBytes(source.file_size)}
                      {" · "}
                      Status: {source.processing_status}
                      {" · "}
                      Upload: {formatDateTime(source.created_at)}
                    </p>
                    {ingest ? (
                      <p className="muted mt-1 text-xs">
                        Zeilen: {ingest.lines_read ?? 0}
                        {" · "}
                        gültig: {ingest.valid_records ?? 0}
                        {" · "}
                        fehlerhaft: {ingest.invalid_lines ?? 0}
                        {" · "}
                        Docs: {ingest.documents_created ?? 0}
                        {" · "}
                        KUs: {ingest.knowledge_units_created ?? 0}
                      </p>
                    ) : null}
                    {source.processing_error ? (
                      <p className="mt-1 text-xs text-amber-800">
                        {source.processing_error}
                      </p>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </section>

        <section className="panel p-6">
          <h2 className="text-xl font-semibold">Knowledge Units</h2>
          <p className="muted mt-1 text-sm">
            Erste {Math.min(20, units?.length ?? 0)} von {unitCount ?? 0}
          </p>
          <ul className="mt-4 divide-y divide-[var(--border)]">
            {(units ?? []).length === 0 ? (
              <li className="muted py-3 text-sm">Noch keine Knowledge Units.</li>
            ) : (
              (units ?? []).map((unit) => {
                const line =
                  unit.source_location &&
                  typeof unit.source_location === "object" &&
                  "line_number" in unit.source_location
                    ? String(
                        (unit.source_location as { line_number?: unknown })
                          .line_number ?? "",
                      )
                    : "";
                return (
                  <li key={unit.id} className="py-3">
                    <Link
                      href={`/projects/${projectId}/units/${unit.id}`}
                      className="font-medium hover:underline"
                    >
                      {unit.title || unit.id.slice(0, 8)}
                    </Link>
                    <p className="muted mt-1 text-xs">
                      Typ: {unit.unit_type}
                      {line ? ` · Zeile ${line}` : ""}
                      {" · "}
                      Status: {unit.processing_status}
                    </p>
                  </li>
                );
              })
            )}
          </ul>
        </section>

        <section className="panel p-6">
          <h2 className="text-xl font-semibold">Processing Jobs</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {(jobs ?? []).length === 0 ? (
              <li className="muted">Keine Jobs.</li>
            ) : (
              (jobs ?? []).map((job) => (
                <li key={job.id}>
                  <span className="font-mono text-xs">{job.id.slice(0, 8)}</span>{" "}
                  · {job.job_type} · <strong>{job.status}</strong>
                  {" · "}
                  <span className="muted text-xs">
                    {formatDateTime(job.created_at)}
                  </span>
                  {job.error ? (
                    <span className="block text-xs text-amber-800">
                      {job.error}
                    </span>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </section>

        <section className="panel p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Chat</h2>
            <form action={createChatSession}>
              <input type="hidden" name="projectId" value={projectId} />
              <button className="btn btn-secondary" type="submit">
                Neue Session
              </button>
            </form>
          </div>

          {latestSession ? (
            <>
              <p className="muted mt-2 text-sm">
                Aktive Session: {latestSession.title}
              </p>
              <div className="mt-4 space-y-3">
                {(messages ?? []).map((message) => (
                  <div
                    key={message.id}
                    className="rounded-lg border border-[var(--border)] bg-[#f8fafc] px-3 py-2 text-sm"
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                      {message.role}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{message.content}</p>
                  </div>
                ))}
              </div>
              <form action={saveUserChatMessage} className="mt-4 space-y-3">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="sessionId" value={latestSession.id} />
                <label className="label" htmlFor="content">
                  Frage stellen
                </label>
                <textarea
                  className="textarea min-h-24"
                  id="content"
                  name="content"
                  required
                  placeholder="Auch als Viewer möglich…"
                />
                <button className="btn btn-primary" type="submit">
                  Senden
                </button>
              </form>
            </>
          ) : (
            <p className="muted mt-3 text-sm">
              Noch keine Session — lege eine an, um Fragen zu stellen.
            </p>
          )}
        </section>
      </main>
    </>
  );
}
