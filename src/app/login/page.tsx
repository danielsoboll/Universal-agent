import { signInWithPassword } from "@/actions/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="panel p-8 shadow-sm">
        <p className="text-sm font-semibold tracking-wide text-[var(--accent)]">
          General Agent
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Anmelden</h1>
        <p className="muted mt-2 text-sm">
          Internes Testsystem — E-Mail und Passwort.
        </p>

        {params.error ? (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-[var(--danger)]">
            {params.error}
          </p>
        ) : null}

        <form action={signInWithPassword} className="mt-6 space-y-4">
          <input type="hidden" name="next" value={params.next || "/"} />
          <div>
            <label className="label" htmlFor="email">
              E-Mail
            </label>
            <input
              className="input"
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Passwort
            </label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </div>
          <button className="btn btn-primary w-full" type="submit">
            Einloggen
          </button>
        </form>
      </div>
    </main>
  );
}
