"use client";

import { useState, useTransition } from "react";
import { askQuestionAction, type AskUiResult } from "@/actions/ask";
import { InlineError, EmptyState } from "@/components/ui/states";
import type { KnowledgeHit } from "@/lib/knowledge/types";

function SourceCard({ source }: { source: KnowledgeHit }) {
  return (
    <details className="rounded-xl border border-[var(--border)] p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        #{source.rank} · {source.title}{" "}
        <span className="muted font-normal">
          ({source.knowledge_unit_type}, Score {source.combined_score.toFixed(2)})
        </span>
      </summary>
      <div className="mt-2 space-y-2 text-sm">
        <p className="muted">
          {[source.object_type, source.object_name, source.subobject_name]
            .filter(Boolean)
            .join(" · ") || "—"}
        </p>
        <p>
          <span className="font-medium">Trefferbegriffe:</span>{" "}
          {source.matched_terms.join(", ") || "—"}
        </p>
        <p className="whitespace-pre-wrap">{source.snippet}</p>
        {source.facts.length ? (
          <div>
            <p className="font-medium">Facts</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {source.facts.slice(0, 6).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {source.inferences.length ? (
          <div>
            <p className="font-medium">Inferences (gekennzeichnet)</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {source.inferences.slice(0, 6).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {source.evidence_refs.length ? (
          <div>
            <p className="font-medium">Evidence</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {source.evidence_refs.slice(0, 5).map((e) => (
                <li key={e} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="muted break-all text-xs">source_key: {source.source_key}</p>
      </div>
    </details>
  );
}

export function AskQuestionPanel({
  projectId,
}: {
  projectId?: string | null;
}) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskUiResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await askQuestionAction({ question, projectId });
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
          placeholder="Ihre freie Frage zum Wissensbestand …"
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
          {pending ? "Wird beantwortet …" : "Frage stellen"}
        </button>
      </form>

      {pending ? (
        <div
          className="panel compact space-y-2 p-4"
          aria-busy="true"
          aria-label="Antwort wird erzeugt"
        >
          <div className="h-4 max-w-[16rem] animate-pulse rounded bg-[var(--surface-raised)]" />
          <div className="h-4 w-full animate-pulse rounded bg-[var(--surface-raised)]" />
          <div className="h-4 max-w-[20rem] animate-pulse rounded bg-[var(--surface-raised)]" />
        </div>
      ) : null}

      {!pending && !result ? (
        <EmptyState
          title="Noch keine Frage"
          message="Antwort und Quellen erscheinen nach dem Absenden."
        />
      ) : null}

      {!pending && result?.status === "error" ? (
        <InlineError
          title="Frage nicht beantwortbar"
          message={result.message ?? "Unbekannter Fehler"}
        />
      ) : null}

      {!pending && result && result.status !== "error" ? (
        <section className="panel compact space-y-4 p-4 sm:p-5">
          <div>
            <h2 className="text-base font-semibold">Direkte Antwort</h2>
            <p className="mt-1 whitespace-pre-wrap text-sm sm:text-base">
              {result.direct_answer}
            </p>
          </div>
          {result.reasoning ? (
            <div>
              <h3 className="text-sm font-semibold">Begründung</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm">{result.reasoning}</p>
            </div>
          ) : null}
          {result.technical_objects.length ? (
            <div>
              <h3 className="text-sm font-semibold">
                Relevante technische Objekte
              </h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {result.technical_objects.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.uncertainties.length ? (
            <div>
              <h3 className="text-sm font-semibold">Unsicherheiten</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {result.uncertainties.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Quellen / Belege</h3>
            {result.sources.length ? (
              result.sources.map((s) => (
                <SourceCard key={`${s.search_document_id}-${s.rank}`} source={s} />
              ))
            ) : (
              <p className="muted text-sm">Keine Quellen.</p>
            )}
          </div>
          <p className="muted text-xs">
            {result.retrieval_summary}
            {result.vector_search_active ? " · Vector aktiv" : " · Vector inaktiv"}
            {result.model ? ` · ${result.model}` : ""}
            {result.estimated_cost
              ? ` · ~$${result.estimated_cost.toFixed(4)}`
              : ""}
          </p>
          {result.warnings.length ? (
            <ul className="muted list-disc space-y-0.5 pl-5 text-xs">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
