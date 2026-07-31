"use client";

import { useState, useTransition } from "react";
import {
  askQuestionAction,
  type AskQuestionResult,
} from "@/actions/ask";
import { InlineError, EmptyState } from "@/components/ui/states";

export function AskQuestionPanel({
  customerId,
}: {
  customerId?: string | null;
}) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskQuestionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await askQuestionAction({ question, customerId });
      setResult(res);
    });
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="label" htmlFor="ask-question">
          Was möchten Sie über Ihr System wissen?
        </label>
        <textarea
          id="ask-question"
          name="question"
          className="textarea min-h-[8.5rem] w-full text-base leading-relaxed sm:min-h-[10rem] sm:text-lg"
          placeholder="Ihre Frage …"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={pending}
          required
        />
        <button
          type="submit"
          className="btn btn-primary w-full sm:w-auto"
          disabled={pending || !question.trim()}
          aria-busy={pending}
        >
          {pending ? "Wird geprüft …" : "Frage stellen"}
        </button>
      </form>

      {pending ? (
        <div
          className="panel compact space-y-2 p-4"
          aria-busy="true"
          aria-label="Antwort wird vorbereitet"
        >
          <div className="h-4 w-2/3 max-w-[16rem] animate-pulse rounded bg-[var(--surface-raised)]" />
          <div className="h-4 w-full animate-pulse rounded bg-[var(--surface-raised)]" />
          <div className="h-4 w-5/6 max-w-[20rem] animate-pulse rounded bg-[var(--surface-raised)]" />
        </div>
      ) : null}

      {!pending && !result ? (
        <EmptyState
          title="Noch keine Frage"
          message="Stellen Sie eine Frage zu Ihrem System. Antworten und Belege erscheinen hier."
        />
      ) : null}

      {!pending && result?.status === "error" ? (
        <InlineError title="Frage nicht möglich" message={result.message} />
      ) : null}

      {!pending && result?.status === "not_connected" ? (
        <section className="panel compact space-y-3 p-4 sm:p-5" role="status">
          <h2 className="text-base font-semibold">Antwort</h2>
          <p className="text-sm sm:text-base">{result.message}</p>
          <div>
            <h3 className="text-sm font-semibold">Quellen / Belege</h3>
            <p className="muted mt-1 text-sm">
              Noch keine Belege — die Suche ist nicht angebunden.
            </p>
          </div>
        </section>
      ) : null}

      {!pending && result?.status === "ok" ? (
        <section className="panel compact space-y-3 p-4 sm:p-5">
          <h2 className="text-base font-semibold">Antwort</h2>
          <p className="whitespace-pre-wrap text-sm sm:text-base">
            {result.answer ?? "—"}
          </p>
          <div>
            <h3 className="text-sm font-semibold">Quellen / Belege</h3>
            {result.evidence.length ? (
              <ul className="mt-2 space-y-2 text-sm">
                {result.evidence.map((ev, i) => (
                  <li key={`${ev.sourceKey ?? ev.title}-${i}`} className="muted">
                    <span className="font-medium text-[var(--fg)]">{ev.title}</span>
                    {ev.snippet ? (
                      <span className="mt-0.5 block">{ev.snippet}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted mt-1 text-sm">Keine Belege geliefert.</p>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
