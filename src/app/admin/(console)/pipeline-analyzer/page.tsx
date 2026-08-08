import Link from "next/link";
import {
  canMutateProjectSetup,
  primaryCustomerId,
  requireProjectConsoleAccess,
} from "@/lib/onboarding/access";
import { EmptyState } from "@/components/ui/states";
import { loadScopedCustomers } from "@/lib/admin/loadScopedCustomers";

/**
 * Placeholder page for the future Pipeline Analyzer.
 * No OpenAI, no retrieval, no ground-truth execution.
 */
export default async function PipelineAnalyzerPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const ctx = await requireProjectConsoleAccess();
  const sp = await searchParams;
  const { customers } = await loadScopedCustomers(ctx);
  const customerId =
    sp.customer || customers[0]?.id || primaryCustomerId(ctx) || undefined;
  const selected = customers.find((c) => c.id === customerId) ?? null;
  const qs = customerId ? `?customer=${encodeURIComponent(customerId)}` : "";
  const canMutate = canMutateProjectSetup(ctx);

  if (!selected) {
    return (
      <div className="space-y-3">
        <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
          Pipeline Analyzer
        </h1>
        <EmptyState
          title="Kein Projekt ausgewählt"
          message="Bitte zuerst ein Projekt im Dashboard wählen"
          actionHref="/admin/dashboard"
          actionLabel="Zum Dashboard"
        />
      </div>
    );
  }

  const chain = [
    "Datenbestand",
    "Gefunden",
    "An OpenAI übergeben",
    "In der Antwort verwendet",
  ];

  const futureSteps = [
    "Datenbestand / Ground Truth",
    "Retrieval-Ergebnis",
    "Evidence-Paket",
    "OpenAI-Eingabe",
    "OpenAI-Antwort",
    "Verwendete und verlorene Evidenz",
    "Fehlerursache und Verbesserungsvorschläge",
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[1.5rem] font-semibold tracking-tight sm:text-[1.75rem]">
          Pipeline Analyzer
        </h1>
        <span className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[0.8125rem] text-[var(--muted)]">
          Vorgesehen
        </span>
      </div>

      <p className="text-[0.9375rem] text-[var(--muted)]">
        Projekt: <span className="text-[var(--foreground)]">{selected.name}</span>
      </p>

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3.5">
        <p className="text-[0.875rem] font-medium text-[var(--muted)]">
          Spätere Kernkette
        </p>
        <ol className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {chain.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[0.9375rem] text-[var(--foreground)]">
                {label}
              </span>
              {i < chain.length - 1 ? (
                <span className="hidden text-[var(--muted)] sm:inline" aria-hidden>
                  →
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="admin-card rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3.5">
        <p className="text-[0.875rem] font-medium text-[var(--muted)]">
          Geplante Analysefunktion
        </p>
        <p className="mt-1.5 text-[0.9375rem] leading-snug text-[var(--muted)]">
          Analysiert zukünftig die komplette Verarbeitungskette:
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[0.9375rem] text-[var(--foreground)]">
          {futureSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="mt-3 text-[0.9375rem] leading-snug text-[var(--muted)]">
          Die Analysefunktion wird nach Abschluss der gemeinsamen Canonical-,
          Relations- und Retrieval-Architektur implementiert.
        </p>
        <p className="mt-2 text-[0.875rem] text-[var(--muted)]">
          Noch nicht aktiv: Ground-Truth-Suche, OpenAI-Auswertung, automatische
          Optimierung, neue Indexlogik oder kostenpflichtige Aktionen.
        </p>
      </section>

      <div className="flex flex-wrap gap-2">
        <Link href={`/admin/dashboard${qs}`} className="btn-secondary-blue">
          Zum Dashboard
        </Link>
        {canMutate ? (
          <Link href={`/admin/project${qs}`} className="btn-secondary-blue">
            Projekt-Administration
          </Link>
        ) : null}
      </div>
    </div>
  );
}
