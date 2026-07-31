import {
  primaryProjectId,
  requireLocalAppAccess,
} from "@/lib/localAuth/session";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { KnowledgeRetriever } from "@/lib/knowledge/knowledgeRetriever";
import { EmptyState } from "@/components/ui/states";

export default async function AppSourcesPage() {
  const ctx = await requireLocalAppAccess();
  const projectId = primaryProjectId(ctx.user);
  const project = projectId
    ? await fileProjectRepository.getById(projectId)
    : null;
  const knowledge = project ? KnowledgeRetriever.inspect(project) : null;

  if (!project || !knowledge) {
    return (
      <EmptyState
        title="Keine Quellen"
        message="Kein Projekt oder Index konfiguriert."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Quellen
        </h1>
        <p className="muted mt-1 text-sm">
          Status des aktiven Wissensindex für {project.name}.
        </p>
      </div>
      <section className="panel compact space-y-2 p-4 sm:p-5 text-sm">
        <p>
          <span className="font-medium">Dokumente:</span>{" "}
          {knowledge.document_count}
        </p>
        <p>
          <span className="font-medium">Embeddings:</span>{" "}
          {knowledge.has_embeddings ? "vorhanden" : "fehlen"}
        </p>
        <p>
          <span className="font-medium">Vector-Index Einträge:</span>{" "}
          {knowledge.vector_index_entries}
        </p>
        <p>
          <span className="font-medium">Aktiver Index:</span>{" "}
          {project.active_index_path}
        </p>
        <p className="muted">{knowledge.message}</p>
      </section>
    </div>
  );
}
