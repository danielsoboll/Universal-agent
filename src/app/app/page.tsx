import Link from "next/link";
import {
  primaryProjectId,
  requireLocalAppAccess,
} from "@/lib/localAuth/session";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { KnowledgeRetriever } from "@/lib/knowledge/knowledgeRetriever";
import { EmptyState } from "@/components/ui/states";

export default async function AppHomePage() {
  const ctx = await requireLocalAppAccess();
  const projectId = primaryProjectId(ctx.user);
  const project = projectId
    ? await fileProjectRepository.getById(projectId)
    : null;
  const knowledge = project ? KnowledgeRetriever.inspect(project) : null;

  if (!project) {
    return (
      <EmptyState
        title="Kein Projekt zugeordnet"
        message="Bitte einen Admin um Projektzuordnung bitten."
      />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <section className="panel compact space-y-2 p-4 sm:p-5">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {project.name}
        </h1>
        <p className="muted text-sm">{project.description || "—"}</p>
        <p className="text-sm">
          Wissensbestand:{" "}
          {knowledge?.ok
            ? `${knowledge.document_count} indexierte Dokumente`
            : knowledge?.message ?? "nicht verfügbar"}
        </p>
        {knowledge && !knowledge.has_embeddings ? (
          <p className="muted text-xs">
            Vector Search: Embeddings fehlen oder nicht aktiv.
          </p>
        ) : null}
      </section>

      <section className="panel compact space-y-3 p-4 sm:p-5">
        <h2 className="text-lg font-semibold">Nächster Schritt</h2>
        <p className="muted text-sm">
          Stellen Sie eine freie Frage an den indexierten Wissensbestand.
        </p>
        <Link href="/app/ask" className="btn btn-primary inline-flex">
          Frage stellen
        </Link>
      </section>
    </div>
  );
}
