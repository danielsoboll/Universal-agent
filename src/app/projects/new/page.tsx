import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { createProject } from "@/actions/projects";

export default function NewProjectPage() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-xl px-6 py-8">
        <Link href="/" className="muted text-sm">
          ← Zurück
        </Link>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          Neues Projekt
        </h1>
        <form action={createProject} className="panel mt-6 space-y-4 p-6">
          <div>
            <label className="label" htmlFor="name">
              Name
            </label>
            <input className="input" id="name" name="name" required />
          </div>
          <div>
            <label className="label" htmlFor="description">
              Beschreibung
            </label>
            <textarea
              className="textarea min-h-28"
              id="description"
              name="description"
            />
          </div>
          <button className="btn btn-primary" type="submit">
            Anlegen
          </button>
        </form>
      </main>
    </>
  );
}
