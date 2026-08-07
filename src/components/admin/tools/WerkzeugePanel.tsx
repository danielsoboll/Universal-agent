"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { syncProjectStatusAction } from "@/actions/projectStatus";

export type WerkzeugePanelProps = {
  customerId: string;
  canMutate: boolean;
};

/**
 * Dashboard section below the six Hauptschritte — tools & QA placeholders.
 */
export function WerkzeugePanel({ customerId, canMutate }: WerkzeugePanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const analyzerHref = `/admin/pipeline-analyzer?customer=${encodeURIComponent(customerId)}`;

  function onSync() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const res = await syncProjectStatusAction({ customerId });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setMessage(res.message);
      router.refresh();
    });
  }

  return (
    <section className="space-y-1.5">
      <p className="text-[0.8125rem] font-medium text-[var(--muted)]">
        Werkzeuge &amp; Qualitätssicherung
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        <article className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[1.0625rem] font-medium text-[var(--foreground)]">
              Pipeline Analyzer
            </h3>
            <span className="shrink-0 rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[0.75rem] text-[var(--muted)]">
              Vorgesehen
            </span>
          </div>
          <p className="mt-1.5 text-[0.9375rem] leading-snug text-[var(--muted)]">
            Prüft für eine Frage oder einen technischen Anker, welche Informationen
            im Datenbestand vorhanden sind, vom Retrieval gefunden, an OpenAI
            übergeben und in der Antwort verwendet wurden.
          </p>
          <Link href={analyzerHref} className="btn-secondary-blue mt-3 inline-flex">
            Pipeline Analyzer öffnen
          </Link>
        </article>

        <article className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[1.0625rem] font-medium text-[var(--foreground)]">
              Projektstatus synchronisieren
            </h3>
            <span className="shrink-0 rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[0.75rem] text-[var(--muted)]">
              Lesend
            </span>
          </div>
          <p className="mt-1.5 text-[0.9375rem] leading-snug text-[var(--muted)]">
            Liest vorhandene Projektartefakte und stellt daraus den tatsächlichen
            Fortschritt der Einrichtung wieder her. Startet keine Pipelines und
            keinen OpenAI-Lauf.
          </p>
          {canMutate ? (
            <button
              type="button"
              className="btn-secondary-blue mt-3"
              disabled={pending}
              onClick={onSync}
            >
              {pending ? "Synchronisiere…" : "Projektstatus synchronisieren"}
            </button>
          ) : (
            <p className="mt-3 text-[0.875rem] text-[var(--muted)]">
              Nur Projekt-Admin kann den Status synchronisieren.
            </p>
          )}
          {message ? (
            <p className="mt-2 text-[0.875rem] text-[var(--foreground)] break-words">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 text-[0.875rem] text-[var(--danger)] break-words">
              {error}
            </p>
          ) : null}
        </article>
      </div>
    </section>
  );
}
