import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { ProviderHealthPanel } from "@/components/ProviderHealthPanel";
import { getMyProjects } from "@/actions/projects";
import { canRunProviderHealthCheck } from "@/actions/aiHealth";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const projects = await getMyProjects();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const memberships =
    user == null
      ? []
      : (
          await supabase
            .from("project_members")
            .select("project_id, role")
            .eq("user_id", user.id)
            .eq("is_active", true)
        ).data ?? [];

  const roleByProject = new Map(
    memberships.map((m) => [m.project_id, m.role as string]),
  );

  const showProviderHealth = await canRunProviderHealthCheck();

  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Projekte</h1>
            <p className="muted mt-1 text-sm">
              Nur Projekte mit aktiver Mitgliedschaft.
            </p>
          </div>
          <Link href="/projects/new" className="btn btn-primary">
            Neues Projekt
          </Link>
        </div>

        <div className="mt-8 grid gap-4">
          {projects.length === 0 ? (
            <div className="panel p-6">
              <p className="font-medium">Noch keine Projekte</p>
              <p className="muted mt-1 text-sm">
                Lege ein Projekt an, um Quellen hochzuladen.
              </p>
            </div>
          ) : (
            projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="panel block p-5 transition hover:border-[var(--accent)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">{project.name}</h2>
                    {project.description ? (
                      <p className="muted mt-1 text-sm">{project.description}</p>
                    ) : null}
                  </div>
                  <span className="badge">
                    {roleByProject.get(project.id) ?? "member"}
                  </span>
                </div>
              </Link>
            ))
          )}
        </div>

        {showProviderHealth ? <ProviderHealthPanel /> : null}
      </main>
    </>
  );
}
