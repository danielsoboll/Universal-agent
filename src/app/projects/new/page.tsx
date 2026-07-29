import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { NewProjectForm } from "@/components/NewProjectForm";

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
        <NewProjectForm />
      </main>
    </>
  );
}
