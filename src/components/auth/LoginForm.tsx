"use client";

import { useState } from "react";
import { InlineError } from "@/components/ui/states";

/** Kaputte/alte Supabase-Auth-Cookies im Browser entfernen (nicht HttpOnly). */
function clearBrowserAuthCookies() {
  if (typeof document === "undefined") return;
  const names = document.cookie
    .split(";")
    .map((c) => c.trim().split("=")[0])
    .filter((n) => n.startsWith("sb-") && n.includes("auth-token"));
  for (const name of names) {
    document.cookie = `${name}=; Path=/; Max-Age=0`;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

export function LoginForm({
  next,
  initialError,
}: {
  next?: string;
  initialError?: string;
}) {
  const [pending, setPending] = useState(false);

  return (
    <form
      action="/auth/signin"
      method="post"
      className="mt-6 space-y-4 pb-safe"
      onSubmit={() => {
        // Wichtig: Inputs NIEMALS disabled setzen vor dem Submit —
        // disabled-Felder werden nicht mitgeschickt → „E-Mail und Passwort erforderlich“.
        clearBrowserAuthCookies();
        setPending(true);
      }}
    >
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
          readOnly={pending}
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
          readOnly={pending}
        />
      </div>
      <button
        className="btn btn-primary w-full"
        type="submit"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? "Anmeldung …" : "Anmelden"}
      </button>
    </form>
  );
}
