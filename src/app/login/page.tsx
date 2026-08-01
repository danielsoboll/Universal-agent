import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import { APP_NAME, APP_TAGLINE } from "@/lib/branding";
import { LoginForm } from "@/components/auth/LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6 sm:py-12">
      <div className="absolute right-4 top-4 pt-safe sm:right-6 sm:top-6">
        <ThemeToggle />
      </div>
      <div className="panel compact p-5 sm:p-8">
        <div className="flex justify-center">
          <BrandMark size={48} href={null} />
        </div>
        <h1 className="mt-4 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
          {APP_NAME}
        </h1>
        <p className="muted mt-1 text-center text-sm">{APP_TAGLINE}</p>
        <p className="muted mt-3 text-center text-sm">
          Anmeldung nur mit bestehendem Konto.
        </p>
        <LoginForm next={params.next} initialError={params.error} />
      </div>
    </main>
  );
}
