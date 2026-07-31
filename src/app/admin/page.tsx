import Link from "next/link";
import { requireLocalAdmin } from "@/lib/localAuth/session";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { fileUserRepository } from "@/lib/localAuth/userRepository";
import { KnowledgeRetriever } from "@/lib/knowledge/knowledgeRetriever";
import { EmptyState } from "@/components/ui/states";

export default async function AdminHomePage() {
  await requireLocalAdmin();
  const projects = await fileProjectRepository.list();
  const users = await fileUserRepository.list();
  const project = projects[0] ?? null;
  const knowledge = project ? KnowledgeRetriever.inspect(project) : null;

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Lokaler Admin
        </h1>
        <p className="muted mt-1 text-sm">
          Projekt und Benutzer für den Frage-Flow konfigurieren.
        </p>
      </div>

      {!project ? (
        <EmptyState
          title="Kein Projekt"
          message="Legen Sie zuerst ein lokales Projekt an."
          actionHref="/admin/project"
          actionLabel="Projekt konfigurieren"
        />
      ) : (
        <section className="panel compact space-y-3 p-4 sm:p-5">
          <h2 className="text-base font-semibold">{project.name}</h2>
          <p className="muted text-sm">{project.description || "—"}</p>
          <p className="text-sm">
            {project.customer_id} / {project.system_id}
          </p>
          <p className="text-sm">
            Wissensbestand:{" "}
            {knowledge?.ok ? knowledge.message : knowledge?.message ?? "—"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/project" className="btn btn-secondary">
              Projekt bearbeiten
            </Link>
            <Link href="/admin/users" className="btn btn-secondary">
              Benutzer ({users.length})
            </Link>
            <a
              href="/app"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              User-Ansicht öffnen
            </a>
          </div>
          <p className="muted text-xs">
            User-Ansicht öffnet einen neuen Tab. Dort bitte mit dem User-Konto
            anmelden (kein automatisches Impersonation).
          </p>
        </section>
      )}
    </div>
  );
}
