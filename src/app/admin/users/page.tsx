import { createLocalUserAction } from "@/actions/localAdmin";
import { requireLocalAdmin } from "@/lib/localAuth/session";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { fileUserRepository } from "@/lib/localAuth/userRepository";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import { EmptyState, InlineError } from "@/components/ui/states";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  await requireLocalAdmin();
  const sp = await searchParams;
  const projects = await fileProjectRepository.list();
  const users = await fileUserRepository.list();
  const project = projects[0] ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Benutzer
        </h1>
        <p className="muted mt-1 text-sm">Lokale Konten für Admin und User.</p>
      </div>

      {sp.error ? (
        <InlineError title="Benutzer nicht angelegt" message={sp.error} />
      ) : null}
      {sp.saved ? (
        <div
          className="panel compact p-3 text-sm"
          style={{ background: "var(--accent-soft)" }}
        >
          Benutzer gespeichert.
        </div>
      ) : null}

      {!project ? (
        <EmptyState
          title="Zuerst Projekt anlegen"
          message="Ohne Projekt keine Benutzerzuordnung."
          actionHref="/admin/project"
          actionLabel="Zum Projekt"
        />
      ) : (
        <form action={createLocalUserAction} className="panel compact space-y-3 p-4 sm:p-5">
          <input type="hidden" name="project_id" value={project.id} />
          <div>
            <label className="label" htmlFor="display_name">
              Name
            </label>
            <input className="input" id="display_name" name="display_name" required />
          </div>
          <div>
            <label className="label" htmlFor="email">
              E-Mail
            </label>
            <input className="input" id="email" name="email" type="email" required />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="role">
                Rolle
              </label>
              <select className="input" id="role" name="role" defaultValue="user">
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="enabled">
                Status
              </label>
              <select className="input" id="enabled" name="enabled" defaultValue="true">
                <option value="true">aktiv</option>
                <option value="false">inaktiv</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="password">
              Initiales Passwort
            </label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
          <p className="muted text-xs">
            Projektzuordnung: {project.name} ({project.id})
          </p>
          <FormSubmitButton pendingLabel="Anlegen …">Benutzer anlegen</FormSubmitButton>
        </form>
      )}

      <section className="panel compact p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Vorhandene Benutzer</h2>
        {users.length ? (
          <ul className="mt-2 space-y-2 text-sm">
            {users.map((u) => (
              <li key={u.id}>
                {u.display_name} · {u.email} · {u.role} ·{" "}
                {u.enabled ? "aktiv" : "inaktiv"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted mt-2 text-sm">Noch keine Benutzer.</p>
        )}
      </section>
    </div>
  );
}
