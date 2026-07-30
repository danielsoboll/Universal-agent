"use client";

import { useFormStatus } from "react-dom";
import { signInWithPassword } from "@/actions/auth";
import { InlineError } from "@/components/ui/states";

function LoginSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      className="btn btn-primary w-full"
      type="submit"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? "Anmeldung …" : "Anmelden"}
    </button>
  );
}

export function LoginForm({
  next,
  initialError,
}: {
  next?: string;
  initialError?: string;
}) {
  return (
    <form action={signInWithPassword} className="mt-6 space-y-4 pb-safe">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {initialError ? (
        <InlineError title="Anmeldung nicht möglich" message={initialError} />
      ) : null}
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
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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
      <LoginSubmit />
    </form>
  );
}
