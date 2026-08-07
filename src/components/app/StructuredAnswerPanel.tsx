"use client";

import { useState } from "react";
import type {
  StructuredAnswer,
  StructuredClaim,
  StructuredEntity,
  StructuredProcessStep,
} from "@/lib/knowledge/structuredAnswer";

function SummaryCard({
  summary,
  answerType,
  sufficient,
}: {
  summary: string;
  answerType: string;
  sufficient: boolean;
}) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <p className="text-[0.75rem] uppercase tracking-wide text-[var(--muted)]">
        {answerType}
        {!sufficient ? " · unvollständig" : ""}
      </p>
      <p className="mt-1 text-sm leading-relaxed sm:text-[0.95rem]">{summary}</p>
    </article>
  );
}

function EvidenceBadge({ claim }: { claim: StructuredClaim }) {
  const tone =
    claim.claim_status === "AUTHORITATIVE"
      ? "border-emerald-600/40 text-emerald-800 dark:text-emerald-300"
      : claim.claim_status === "CODE_DERIVED"
        ? "border-sky-600/40 text-sky-800 dark:text-sky-300"
        : "border-amber-600/40 text-amber-800 dark:text-amber-300";
  return (
    <li
      className={`rounded-lg border bg-[var(--bg)] px-3 py-2 text-[0.8125rem] ${tone}`}
    >
      <span className="text-[0.7rem] font-medium uppercase tracking-wide opacity-80">
        {claim.claim_status}
        {claim.confidence ? ` · ${Math.round(claim.confidence * 100)}%` : ""}
      </span>
      <p className="mt-0.5 leading-relaxed">{claim.claim_text}</p>
      {claim.source_types.length > 0 ? (
        <p className="mt-1 text-[0.7rem] text-[var(--muted)]">
          Quellen: {claim.source_types.join(", ")}
        </p>
      ) : null}
    </li>
  );
}

function ProcessStepCard({
  step,
  index,
}: {
  step: StructuredProcessStep;
  index: number;
}) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
      <p className="text-sm leading-relaxed">
        <span className="mr-1.5 font-semibold text-[var(--muted)]">
          {index + 1}.
        </span>
        {step.text}
      </p>
      {step.technical_refs.length > 0 ? (
        <p className="mt-1.5 text-[0.75rem] text-[var(--muted)]">
          Beleg: {step.technical_refs.join(", ")}
        </p>
      ) : null}
    </article>
  );
}

function EntityCard({ entity }: { entity: StructuredEntity }) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold tracking-tight break-all">{entity.name}</h3>
        <span className="text-[0.75rem] text-[var(--muted)]">
          {entity.entity_type}
          {entity.role ? ` · ${entity.role}` : ""}
        </span>
      </header>
      {entity.rationale ? (
        <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">
          {entity.rationale}
        </p>
      ) : null}
      {entity.matched_methods.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {entity.matched_methods.map((m) => (
            <li
              key={m}
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[0.7rem] font-medium"
            >
              {m}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function MissingInformationCard({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <article className="rounded-xl border border-dashed border-[var(--border)] p-3">
      <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
        Fehlende / offene Informationen
      </h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[0.8125rem] text-[var(--muted)]">
        {items.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </article>
  );
}

function TechnicalEvidenceAccordion({
  discarded,
  evidenceIds,
}: {
  discarded: StructuredAnswer["discarded_candidates"];
  evidenceIds: string[];
}) {
  const [open, setOpen] = useState(false);
  if (discarded.length === 0 && evidenceIds.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        className="text-[0.875rem] font-medium text-[var(--accent)] underline-offset-2 hover:underline"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Technische Belege anzeigen
      </button>
      {open ? (
        <div className="mt-2 space-y-2 text-[0.75rem] text-[var(--muted)]">
          {evidenceIds.length > 0 ? (
            <div>
              <p className="font-medium text-[var(--fg)]">Evidence-IDs</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                {[...new Set(evidenceIds)].slice(0, 40).map((id) => (
                  <li key={id} className="break-all">
                    {id}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {discarded.length > 0 ? (
            <div>
              <p className="font-medium text-[var(--fg)]">
                Verworfene Kandidaten
              </p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                {discarded.slice(0, 40).map((d) => (
                  <li key={d.id} className="break-all">
                    {d.display} — {d.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StructuredAnswerPanel({
  answer,
}: {
  answer: StructuredAnswer;
}) {
  const evidenceIds = [
    ...answer.confirmed_facts.flatMap((c) => c.evidence_ids),
    ...answer.derived_findings.flatMap((c) => c.evidence_ids),
    ...answer.process_steps.flatMap((s) => s.evidence_ids),
  ];

  return (
    <section className="panel compact space-y-4 p-4 sm:p-5">
      <h2 className="text-base font-semibold tracking-tight">Antwort</h2>

      <SummaryCard
        summary={answer.summary}
        answerType={answer.answer_type}
        sufficient={answer.evidence_coverage.sufficient}
      />

      {answer.confirmed_facts.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Sicher belegt
          </h3>
          <ul className="space-y-2">
            {answer.confirmed_facts.map((c, i) => (
              <EvidenceBadge key={`c-${i}`} claim={c} />
            ))}
          </ul>
        </div>
      ) : null}

      {answer.derived_findings.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Ableitungen
          </h3>
          <ul className="space-y-2">
            {answer.derived_findings.map((c, i) => (
              <EvidenceBadge key={`d-${i}`} claim={c} />
            ))}
          </ul>
        </div>
      ) : null}

      {answer.process_steps.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Fachlicher Ablauf
          </h3>
          <div className="space-y-2">
            {answer.process_steps.map((s, i) => (
              <ProcessStepCard key={`s-${i}`} step={s} index={i} />
            ))}
          </div>
        </div>
      ) : null}

      {answer.entities.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Entitäten ({answer.entities.length})
          </h3>
          <div className="space-y-2">
            {answer.entities.slice(0, 40).map((e) => (
              <EntityCard key={e.id} entity={e} />
            ))}
          </div>
        </div>
      ) : null}

      <MissingInformationCard items={answer.missing_information} />

      <TechnicalEvidenceAccordion
        discarded={answer.discarded_candidates}
        evidenceIds={evidenceIds}
      />
    </section>
  );
}
