import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <main className="page-shell flex min-h-screen items-center justify-center px-4">
      <div className="panel w-full max-w-md space-y-3 p-6 text-center">
        <h1 className="text-xl font-semibold">Kein Zugriff</h1>
        <p className="muted text-sm">
          Diese Seite ist für Ihre Rolle nicht freigegeben.
        </p>
        <Link href="/app" className="btn btn-primary inline-flex">
          Zur User-App
        </Link>
      </div>
    </main>
  );
}
