import { saveLocalProjectAction } from "@/actions/localAdmin";
import { requireLocalAdmin } from "@/lib/localAuth/session";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { KnowledgeRetriever } from "@/lib/knowledge/knowledgeRetriever";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import { InlineError } from "@/components/ui/states";
import { getLocalDataRoot } from "@/lib/localData/root";

export default async function AdminProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; status?: string }>;
}) {
  await requireLocalAdmin();
  const sp = await searchParams;
  const projects = await fileProjectRepository.list();
  const project = projects[0] ?? null;
  const root = (() => {
    try {
      return getLocalDataRoot();
    } catch {
      return "";
    }
  })();
  const knowledge = project ? KnowledgeRetriever.inspect(project) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Projekt
        </h1>
        <p className="muted mt-1 text-sm">
          Lokale Konfiguration des Wissensbestands.
        </p>
      </div>

      {sp.error ? (
        <InlineError title="Speichern fehlgeschlagen" message={sp.error} />
      ) : null}
      {sp.saved ? (
        <div
          className="panel compact p-3 text-sm"
          style={{ background: "var(--accent-soft)" }}
        >
          Gespeichert. {sp.status ? `Prüfung: ${sp.status}` : ""}
        </div>
      ) : null}

      <form action={saveLocalProjectAction} className="panel compact space-y-3 p-4 sm:p-5">
        <input type="hidden" name="id" value={project?.id ?? ""} />
        <div>
          <label className="label" htmlFor="name">
            Projektname
          </label>
          <input
            className="input"
            id="name"
            name="name"
            required
            defaultValue={project?.name ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="description">
            Beschreibung
          </label>
          <textarea
            className="textarea"
            id="description"
            name="description"
            rows={2}
            defaultValue={project?.description ?? ""}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="customer_id">
              Customer-ID
            </label>
            <input
              className="input"
              id="customer_id"
              name="customer_id"
              required
              defaultValue={project?.customer_id ?? "P01"}
            />
          </div>
          <div>
            <label className="label" htmlFor="system_id">
              System-ID
            </label>
            <input
              className="input"
              id="system_id"
              name="system_id"
              required
              defaultValue={project?.system_id ?? "D01"}
            />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="local_data_root">
            LOCAL_DATA_ROOT Override (optional)
          </label>
          <p className="muted mb-1 text-xs">
            Leer = {"{LOCAL_DATA_ROOT}"}/{`{customer_id}`} · aktuell: {root || "—"}
          </p>
          <input
            className="input"
            id="local_data_root"
            name="local_data_root"
            defaultValue={project?.local_data_root ?? ""}
            placeholder={root ? `${root}/P01` : ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="active_index_path">
            Aktiver Search-Index (relativ)
          </label>
          <input
            className="input"
            id="active_index_path"
            name="active_index_path"
            defaultValue={project?.active_index_path ?? "indexes/search"}
          />
        </div>
        <div>
          <label className="label" htmlFor="enabled_knowledge_unit_types">
            Knowledge-Unit-Typen (optional, kommagetrennt)
          </label>
          <input
            className="input"
            id="enabled_knowledge_unit_types"
            name="enabled_knowledge_unit_types"
            defaultValue={(project?.enabled_knowledge_unit_types ?? []).join(", ")}
            placeholder="leer = alle"
          />
        </div>
        {knowledge ? (
          <p className="text-sm">
            Status: {knowledge.ok ? "OK" : "Fehler"} — {knowledge.message}
          </p>
        ) : null}
        <FormSubmitButton pendingLabel="Speichern …">Speichern und prüfen</FormSubmitButton>
      </form>
    </div>
  );
}
