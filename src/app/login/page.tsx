import { signInWithPassword } from "@/actions/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import { APP_NAME, APP_TAGLINE } from "@/lib/branding";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="panel p-8">
        <div className="flex justify-center">
          <BrandMark size={56} href={null} />
        </div>
        <h1 className="mt-4 text-center text-3xl font-semibold tracking-tight">
          {APP_NAME}
        </h1>
        <p className="muted mt-1 text-center text-sm">{APP_TAGLINE}</p>
        <p className="muted mt-4 text-center text-sm">
          Anmeldung nur mit bestehendem Konto. Hier kann kein Benutzer angelegt
          werden.
        </p>

        {params.error ? (
          <p
            className="mt-4 rounded-xl px-3 py-2 text-sm text-[var(--danger)]"
            style={{ background: "var(--danger-soft)" }}
          >
            {params.error}
          </p>
        ) : null}

        <form action={signInWithPassword} className="mt-6 space-y-4">
          {params.next ? (
            <input type="hidden" name="next" value={params.next} />
          ) : null}
          <div>
            <label className="label" htmlFor="email">
              Benutzername (E-Mail)
            </label>
            <input
              className="input"
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              inputMode="email"
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
            Anmelden
          </button>
        </form>
      </div>
    </main>
  );
}
