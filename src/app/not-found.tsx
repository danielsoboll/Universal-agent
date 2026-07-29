import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold">Nicht gefunden</h1>
      <p className="muted mt-2">
        Projekt existiert nicht oder du hast keine aktive Mitgliedschaft.
      </p>
      <Link href="/" className="btn btn-primary mt-6 w-fit">
        Zur Übersicht
      </Link>
    </main>
  );
}
