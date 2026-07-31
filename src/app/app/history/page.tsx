import {
  primaryProjectId,
  requireLocalAppAccess,
} from "@/lib/localAuth/session";
import { fileHistoryRepository } from "@/lib/localAuth/historyRepository";
import { EmptyState } from "@/components/ui/states";

export default async function AppHistoryPage() {
  const ctx = await requireLocalAppAccess();
  const projectId = primaryProjectId(ctx.user) ?? undefined;
  const entries = await fileHistoryRepository.listForUser(
    ctx.user.id,
    projectId,
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Verlauf
        </h1>
        <p className="muted mt-1 text-sm">Nur Ihre eigenen Fragen.</p>
      </div>
      {!entries.length ? (
        <EmptyState
          title="Noch kein Verlauf"
          message="Beantwortete Fragen erscheinen hier nach dem Absenden."
          actionHref="/app/ask"
          actionLabel="Frage stellen"
        />
      ) : (
        <ul className="space-y-3">
          {entries.map((e) => (
            <li key={e.id} className="panel compact space-y-2 p-4">
              <p className="text-sm font-semibold">{e.question}</p>
              <p className="whitespace-pre-wrap text-sm">{e.answer}</p>
              <p className="muted text-xs">
                {new Date(e.created_at).toLocaleString("de-DE")} ·{" "}
                {e.retrieval_summary} · {e.source_refs.length} Quellen
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
