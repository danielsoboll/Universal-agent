"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  askQuestionAction,
  type AskQuestionResult,
} from "@/actions/ask";
import type {
  CompactTechnicalDetails,
  ProcessAnswer,
  TechnicalDetails,
} from "@/lib/knowledge/answerSchema";
import type { QueryPlan, SearchMode } from "@/lib/knowledge/queryPlanSchema";
import type { EntityGroundingResult } from "@/lib/knowledge/entityGrounding";
import { InlineError, EmptyState } from "@/components/ui/states";
import {
  cacheKeyFromAskResult,
  getCachedAskResult,
  getSessionAskId,
  modesCachedForQuestion,
  normalizeAskQuestion,
  putCachedAskResult,
} from "@/lib/app/askSessionCache";

const SEARCH_MODES: { key: SearchMode; label: string; help: string }[] = [
  {
    key: "direct_rag",
    label: "Direkte Suche",
    help: "Sucht Ihre Frage direkt im vorhandenen Wissensbestand.",
  },
  {
    key: "planned_rag",
    label: "KI-Tiefensuche",
    help: "Analysiert Ihre Frage zuerst und erzeugt daraus gezielte Suchaufträge.",
  },
];

function searchModeLabel(mode?: SearchMode | null): string {
  return SEARCH_MODES.find((m) => m.key === mode)?.label ?? mode ?? "—";
}

function formatDuration(ms?: number | null): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function SearchModeToggle({
  mode,
  onChange,
  disabled,
  cachedModes,
}: {
  mode: SearchMode;
  onChange: (m: SearchMode) => void;
  disabled?: boolean;
  /** Modes with a stored result for the *exact* current question text */
  cachedModes?: Set<SearchMode>;
}) {
  const active = SEARCH_MODES.find((m) => m.key === mode) ?? SEARCH_MODES[0]!;
  return (
    <div className="space-y-2">
      <span className="label">Suchmodus</span>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Suchmodus wählen"
      >
        {SEARCH_MODES.map((m) => {
          const hasCache = cachedModes?.has(m.key) ?? false;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => onChange(m.key)}
              disabled={disabled}
              aria-pressed={mode === m.key}
              title={
                hasCache
                  ? "Gespeichertes Ergebnis für exakt diese Frage und diesen Suchmodus vorhanden."
                  : undefined
              }
              className={
                mode === m.key
                  ? "btn btn-primary px-3 py-1.5 text-sm"
                  : "btn btn-secondary px-3 py-1.5 text-sm"
              }
            >
              {m.label}
              {hasCache ? (
                <span className="ml-1.5 text-[0.65rem] opacity-80" aria-hidden>
                  ●
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="muted text-xs">{active.help}</p>
      {cachedModes && cachedModes.size > 0 ? (
        <p className="muted text-[0.65rem]">
          ● = Gespeichertes Ergebnis für exakt diese Frage und diesen Suchmodus
          vorhanden (nur Anzeige, kein Kontext für neue Fragen).
        </p>
      ) : null}
    </div>
  );
}

function SearchPlanBlock({ plan }: { plan: QueryPlan }) {
  return (
    <details className="panel compact group">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">
        Verwendeter Suchplan
        <span className="ml-2 text-xs font-normal text-[var(--muted)]">
          (aufklappen)
        </span>
      </summary>
      <div className="space-y-4 border-t border-[var(--border)] px-4 py-3 text-sm">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Intent
          </h4>
          <p className="mt-1">
            {plan.intent}
            {plan.planner_confidence != null
              ? ` · Confidence ${plan.planner_confidence.toFixed(2)}`
              : ""}
          </p>
        </div>

        {plan.entities.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Erkannte Entitäten
            </h4>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {plan.entities.map((e, i) => (
                <li key={i}>
                  {e.value}{" "}
                  <span className="muted text-xs">
                    ({e.type}
                    {e.confidence ? `, Confidence ${e.confidence.toFixed(2)}` : ""})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {plan.subqueries.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Suchaufträge (Subqueries)
            </h4>
            <ul className="mt-1 space-y-2">
              {plan.subqueries.map((sq) => (
                <li
                  key={sq.id}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-2"
                >
                  <p className="font-medium">
                    {sq.id}: {sq.query}
                  </p>
                  {sq.purpose ? (
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {sq.purpose}
                    </p>
                  ) : null}
                  {sq.target_types.length > 0 ||
                  sq.relation_expansion !== "none" ? (
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {sq.target_types.length
                        ? `Zieltypen: ${sq.target_types.join(", ")}`
                        : ""}
                      {sq.relation_expansion !== "none"
                        ? `${sq.target_types.length ? " · " : ""}Relationserweiterung: ${sq.relation_expansion}`
                        : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {plan.required_evidence.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Benötigte Belegarten
            </h4>
            <p className="mt-1 text-xs">
              {plan.required_evidence.join(", ")}
            </p>
          </div>
        ) : null}

        {plan.ambiguities.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Ambiguitäten
            </h4>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
              {plan.ambiguities.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SearchModeSummary({ result }: { result: AskQuestionResult }) {
  const usedLabel = searchModeLabel(result.searchMode);
  const requestedLabel = searchModeLabel(result.requestedSearchMode);
  const fellBack =
    Boolean(result.plannerFallback) &&
    result.requestedSearchMode !== result.searchMode;

  return (
    <section className="panel compact space-y-2 p-4 text-sm">
      <h3 className="text-sm font-semibold">Suchmodus &amp; Kennzahlen</h3>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
        <dt className="text-[var(--muted)]">Verwendeter Suchmodus</dt>
        <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
          {usedLabel}
        </dd>
        <dt className="text-[var(--muted)]">Laufzeit</dt>
        <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
          {formatDuration(result.durationMs)}
        </dd>
        <dt className="text-[var(--muted)]">Anzahl Suchanfragen</dt>
        <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
          {result.subqueryCount ?? "—"}
        </dd>
        <dt className="text-[var(--muted)]">Dokumente durchsucht</dt>
        <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
          {result.searchedDocumentCount ?? "—"}
        </dd>
        <dt className="text-[var(--muted)]">Tokens</dt>
        <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
          {result.tokenUsage
            ? `in ${result.tokenUsage.input} / out ${result.tokenUsage.output} / emb ${result.tokenUsage.embedding}`
            : "—"}
        </dd>
        <dt className="text-[var(--muted)]">Kosten (geschätzt)</dt>
        <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
          {result.estimatedCost != null
            ? `$${result.estimatedCost.toFixed(6)}`
            : "—"}
        </dd>
      </dl>
      {fellBack ? (
        <p className="text-xs text-[var(--muted)]">
          Angefragt: {requestedLabel}. KI-Tiefensuche war nicht möglich, es
          wurde auf {usedLabel} zurückgefallen.
        </p>
      ) : null}
    </section>
  );
}

function ScoreBadge({ label, value }: { label: string; value?: number }) {
  if (value == null || Number.isNaN(value)) return null;
  return (
    <span className="badge text-[0.65rem]">
      {label} {value.toFixed(2)}
    </span>
  );
}

function ProcessAnswerBlock({
  process,
  fallbackAnswer,
  relevanceGate,
  status,
}: {
  process?: ProcessAnswer | null;
  fallbackAnswer?: string | null;
  relevanceGate?: AskQuestionResult["relevanceGate"];
  status?: AskQuestionResult["status"];
}) {
  const pa = process ?? {
    direct_answer: fallbackAnswer ?? "",
    special_process: "",
    trigger: "",
    process_effect: "",
    business_interpretation: "",
    open_validation_questions: [],
  };

  const insufficient =
    status === "insufficient" ||
    relevanceGate?.answerability === "insufficient";

  if (insufficient) {
    return (
      <section className="panel compact space-y-3 p-4 sm:p-5">
        <h2 className="text-base font-semibold tracking-tight">Prozessantwort</h2>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Direkte Antwort
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed sm:text-[0.95rem]">
            {pa.direct_answer.trim() ||
              "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar."}
          </p>
        </div>
        {relevanceGate?.reason ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Warum
            </p>
            <p className="mt-1 text-sm">{relevanceGate.reason}</p>
          </div>
        ) : null}
        {relevanceGate?.missingConcepts?.length ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Fehlende Belege
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
              {relevanceGate.missingConcepts.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {pa.open_validation_questions.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Hinweise
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm leading-relaxed">
              {pa.open_validation_questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  }

  const rows: Array<{ label: string; value: string }> = [
    { label: "Direkte Antwort", value: pa.direct_answer },
    { label: "Erkannte Besonderheit", value: pa.special_process },
    { label: "Auslöser", value: pa.trigger },
    { label: "Prozesswirkung", value: pa.process_effect },
    { label: "Bedeutung", value: pa.business_interpretation },
  ].filter((r) => r.value.trim());

  return (
    <section className="panel compact space-y-3 p-4 sm:p-5">
      <h2 className="text-base font-semibold tracking-tight">Prozessantwort</h2>
      {relevanceGate?.answerability === "partially_answerable" ? (
        <p className="text-xs text-[var(--muted)]">
          Teilweise beantwortbar — fehlende Konzepte bleiben offen.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">—</p>
      ) : (
        <dl className="space-y-3">
          {rows.map((r) => (
            <div key={r.label}>
              <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                {r.label}
              </dt>
              <dd className="mt-1 whitespace-pre-wrap text-sm leading-relaxed sm:text-[0.95rem]">
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {pa.open_validation_questions.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Offen
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm leading-relaxed">
            {pa.open_validation_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function TechList({
  title,
  items,
}: {
  title: string;
  items?: string[] | null;
}) {
  if (!items?.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        {title}
      </h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
        {items.map((item, i) => (
          <li key={i} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TechnicalDetailsBlock({
  details,
  retrievalMode,
  topScore,
  vectorSearchActive,
  searchedDocumentCount,
}: {
  details?: TechnicalDetails | null;
  retrievalMode?: string;
  topScore?: number | null;
  vectorSearchActive?: boolean;
  searchedDocumentCount?: number;
}) {
  if (!details) return null;

  return (
    <details className="panel compact group">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">
        Technische Details
        <span className="ml-2 text-xs font-normal text-[var(--muted)]">
          (aufklappen)
        </span>
      </summary>
      <div className="space-y-4 border-t border-[var(--border)] px-4 py-3">
        {details.sources.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Technische Quelle
            </h4>
            <ul className="mt-1 space-y-2 text-sm">
              {details.sources.map((s, i) => (
                <li
                  key={`${s.source_key}-${i}`}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-2"
                >
                  <p className="font-medium">
                    {s.object_kind || s.knowledge_unit_type || "Objekt"}
                    {s.class_or_program ? ` · ${s.class_or_program}` : ""}
                    {s.method_or_routine ? ` / ${s.method_or_routine}` : ""}
                  </p>
                  {s.source_key ? (
                    <p className="mt-0.5 break-all font-mono text-xs text-[var(--muted)]">
                      {s.source_key}
                    </p>
                  ) : null}
                  {s.rank != null || s.score != null ? (
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {s.rank != null ? `Rang #${s.rank}` : ""}
                      {s.score != null
                        ? `${s.rank != null ? " · " : ""}Score ${s.score.toFixed(2)}`
                        : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <TechList title="Aufrufkette" items={details.callers} />
        <TechList title="Aufgerufene Objekte" items={details.called_objects} />
        <TechList title="Bedingung" items={details.conditions} />
        <TechList title="Datenzugriffe" items={details.table_accesses} />
        <TechList title="Hardcodings" items={details.hardcoded_values} />
        <TechList title="Systemwirkung / Felder" items={details.changed_fields} />
        <TechList title="Evidence" items={details.evidence} />
        <TechList title="Facts" items={details.facts} />
        <TechList title="Inferences" items={details.inferences} />

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Bewertung
          </h4>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-[var(--muted)] sm:grid-cols-3">
            {details.confidence != null ? (
              <>
                <dt>Confidence</dt>
                <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
                  {details.confidence.toFixed(2)}
                </dd>
              </>
            ) : null}
            {retrievalMode ? (
              <>
                <dt>Suchmodus</dt>
                <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
                  {retrievalMode}
                </dd>
              </>
            ) : null}
            {searchedDocumentCount != null ? (
              <>
                <dt>Dokumente</dt>
                <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
                  {searchedDocumentCount}
                </dd>
              </>
            ) : null}
            {topScore != null ? (
              <>
                <dt>Top-Score</dt>
                <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
                  {topScore.toFixed(3)}
                </dd>
              </>
            ) : null}
            {vectorSearchActive != null ? (
              <>
                <dt>Vector</dt>
                <dd className="font-medium text-[var(--foreground)] sm:col-span-2">
                  {vectorSearchActive ? "aktiv" : "nein"}
                </dd>
              </>
            ) : null}
          </dl>
          {details.retrieval_scores?.length ? (
            <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
              {details.retrieval_scores.slice(0, 8).map((s) => (
                <li key={s.rank}>
                  #{s.rank} Σ{s.combined.toFixed(2)}
                  {s.exact != null ? ` exakt ${s.exact.toFixed(2)}` : ""}
                  {s.fulltext != null ? ` text ${s.fulltext.toFixed(2)}` : ""}
                  {s.vector != null ? ` vec ${s.vector.toFixed(2)}` : ""}
                  {" · "}
                  {s.title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </details>
  );
}

const GROUNDING_STATUS_LABEL: Record<EntityGroundingResult["grounding_status"], string> = {
  confirmed: "Belegt",
  possible: "Möglich (indirekt)",
  contradicted: "Widersprochen",
  not_found: "Nicht gefunden",
};

function GroundingBadge({ status }: { status: EntityGroundingResult["grounding_status"] }) {
  const tone =
    status === "confirmed"
      ? "border-green-600/40 text-green-700 dark:text-green-400"
      : status === "possible"
        ? "border-amber-600/40 text-amber-700 dark:text-amber-400"
        : "border-red-600/40 text-red-700 dark:text-red-400";
  return (
    <span className={`badge text-[0.65rem] ${tone}`}>
      {GROUNDING_STATUS_LABEL[status]}
    </span>
  );
}

function EntityGroundingBlock({ entities }: { entities?: EntityGroundingResult[] | null }) {
  if (!entities?.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        Entity-Grounding
      </h4>
      <ul className="mt-1 space-y-1.5">
        {entities.map((e, i) => (
          <li key={`${e.query_entity}-${i}`} className="text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-[var(--foreground)]">
                „{e.query_entity}“
              </span>
              <span className="text-[var(--muted)]">({e.entity_type})</span>
              <GroundingBadge status={e.grounding_status} />
            </div>
            <p className="mt-0.5 text-[var(--muted)]">{e.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CompactTechSection({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        {title}
      </h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
        {items.map((item, i) => (
          <li key={i} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Compact technical explanation — max 5 sections (Quelle, Auslöser,
 * Systemaktion, Beleg, Unsicherheit). Explains only the concrete found
 * rule, not a dump of everything retrieved. Raw/full analysis is opt-in
 * via a separate developer link.
 */
function CompactTechnicalDetailsBlock({
  compact,
  entityGrounding,
  rawDetails,
  retrievalMode,
  topScore,
  vectorSearchActive,
  searchedDocumentCount,
}: {
  compact?: CompactTechnicalDetails | null;
  entityGrounding?: EntityGroundingResult[] | null;
  rawDetails?: TechnicalDetails | null;
  retrievalMode?: string;
  topScore?: number | null;
  vectorSearchActive?: boolean;
  searchedDocumentCount?: number;
}) {
  const [showFull, setShowFull] = useState(false);
  const hasCompactContent =
    Boolean(compact) &&
    (compact!.quelle.length ||
      compact!.ausloeser.length ||
      compact!.systemaktion.length ||
      compact!.beleg.length ||
      compact!.unsicherheit.length);

  if (!hasCompactContent && !entityGrounding?.length) return null;

  return (
    <details className="panel compact group">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">
        Technische Details
        <span className="ml-2 text-xs font-normal text-[var(--muted)]">
          (aufklappen)
        </span>
      </summary>
      <div className="space-y-4 border-t border-[var(--border)] px-4 py-3">
        {compact ? (
          <>
            <CompactTechSection title="Quelle" items={compact.quelle} />
            <CompactTechSection title="Auslöser" items={compact.ausloeser} />
            <CompactTechSection title="Systemaktion" items={compact.systemaktion} />
            <CompactTechSection title="Beleg" items={compact.beleg} />
            <CompactTechSection title="Unsicherheit" items={compact.unsicherheit} />
          </>
        ) : null}

        <EntityGroundingBlock entities={entityGrounding} />

        {compact?.hidden_hardcodings.length ? (
          <p className="text-xs text-[var(--muted)]">
            {compact.hidden_hardcodings.length} Hardcoding(s) ohne eindeutig
            zugeordnete Rolle — nur in der vollständigen Analyse sichtbar.
          </p>
        ) : null}

        <button
          type="button"
          className="text-xs font-medium text-[var(--accent,#2563eb)] underline underline-offset-2"
          onClick={() => setShowFull((v) => !v)}
        >
          {showFull ? "Vollständige Analyse ausblenden" : "Vollständige Analyse anzeigen"}
        </button>

        {showFull ? (
          <div className="border-t border-[var(--border)] pt-3">
            <TechnicalDetailsBlock
              details={rawDetails}
              retrievalMode={retrievalMode}
              topScore={topScore}
              vectorSearchActive={vectorSearchActive}
              searchedDocumentCount={searchedDocumentCount}
            />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SourceCard({
  ev,
  index,
  insufficientLabel,
}: {
  ev: AskQuestionResult["evidence"][number];
  index: number;
  /** Mark retrieval hits that did not pass the relevance gate. */
  insufficientLabel?: boolean;
}) {
  return (
    <details className="panel compact p-3 text-sm">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium leading-snug">
              {ev.rank != null ? `#${ev.rank} · ` : `${index + 1}. `}
              {ev.title}
            </p>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              {[ev.knowledgeUnitType, ev.objectLabel].filter(Boolean).join(" · ")}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {insufficientLabel ? (
                <span className="badge text-[0.65rem] border-amber-600/40 text-amber-700 dark:text-amber-400">
                  Nicht ausreichend
                </span>
              ) : null}
              {ev.facts?.[0] ? (
                <span className="badge text-[0.65rem]">Fact</span>
              ) : null}
              {ev.inferences?.[0] ? (
                <span className="badge text-[0.65rem]">Inference</span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            <ScoreBadge label="Σ" value={ev.score} />
            <ScoreBadge label="exakt" value={ev.exactScore} />
            <ScoreBadge label="text" value={ev.fulltextScore} />
            <ScoreBadge label="vec" value={ev.vectorScore} />
          </div>
        </div>
      </summary>
      <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
        {ev.snippet ? (
          <p className="text-sm leading-relaxed">{ev.snippet}</p>
        ) : null}
        {ev.sourceKey ? (
          <p className="break-all font-mono text-xs text-[var(--muted)]">
            {ev.sourceKey}
          </p>
        ) : null}
        {ev.hardcodedValues?.length ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">
              Hardcodings
            </p>
            <p className="mt-1 break-words font-mono text-xs">
              {ev.hardcodedValues.slice(0, 20).join(", ")}
            </p>
          </div>
        ) : null}
        {(ev.tablesRead?.length || ev.tablesWritten?.length) ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">
              Tabellenzugriff
            </p>
            <p className="mt-1 text-xs">
              {[
                ...(ev.tablesRead ?? []).map((t) => `READ ${t}`),
                ...(ev.tablesWritten ?? []).map((t) => `WRITE ${t}`),
              ].join(" · ")}
            </p>
          </div>
        ) : null}
        {ev.calledMethods?.length ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">
              Aufrufe
            </p>
            <p className="mt-1 text-xs">{ev.calledMethods.join(", ")}</p>
          </div>
        ) : null}
        {ev.facts?.length ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">Facts</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
              {ev.facts.slice(0, 8).map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {ev.inferences?.length ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">
              Inferences
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
              {ev.inferences.slice(0, 8).map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {ev.evidence?.length ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">
              Evidence
            </p>
            <ul className="mt-1 space-y-1 text-xs text-[var(--muted)]">
              {ev.evidence.slice(0, 6).map((e, i) => (
                <li key={i} className="break-words">
                  <span className="font-medium">[{e.statement_type}]</span>{" "}
                  {e.text ?? ""}
                  {(e.lines ?? [])
                    .slice(0, 2)
                    .map((l) =>
                      l.quote
                        ? ` · Z.${l.line ?? "?"}: ${l.quote}`
                        : "",
                    )
                    .join("")}
                </li>
              ))}
            </ul>
          </div>
        ) : ev.evidenceRefs?.length ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">
              Evidence
            </p>
            <ul className="mt-1 space-y-1 text-xs text-[var(--muted)]">
              {ev.evidenceRefs.slice(0, 8).map((ref, i) => (
                <li key={i} className="break-words font-mono">
                  {ref}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {ev.confidence != null ? (
          <p className="text-xs text-[var(--muted)]">
            Confidence {ev.confidence.toFixed(2)}
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function AskQuestionPanel({
  customerId,
}: {
  customerId?: string | null;
}) {
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [mode, setMode] = useState<SearchMode>("direct_rag");
  const [result, setResult] = useState<AskQuestionResult | null>(null);
  const [cachedModes, setCachedModes] = useState<Set<SearchMode>>(
    () => new Set(),
  );
  const [pending, startTransition] = useTransition();
  const [apiError, setApiError] = useState<string | null>(null);
  const [fromSessionCache, setFromSessionCache] = useState(false);
  /** Monotonic id so late responses from an older ask never overwrite a newer one. */
  const requestSeqRef = useRef(0);

  const projectId = customerId?.trim() || "";

  function refreshCachedModesFor(q: string) {
    if (!projectId) {
      setCachedModes(new Set());
      return;
    }
    setCachedModes(
      modesCachedForQuestion({
        projectId,
        normalizedQuestion: q,
      }),
    );
  }

  useEffect(() => {
    refreshCachedModesFor(question);
  }, [question, projectId]);

  function clearActiveAnswerContext() {
    setResult(null);
    setFromSessionCache(false);
    setApiError(null);
  }

  function selectMode(next: SearchMode) {
    if (next === mode) return;
    setMode(next);
    setApiError(null);
    const q = normalizeAskQuestion(question);
    if (!q || !projectId) {
      clearActiveAnswerContext();
      return;
    }
    // Display-only: never call the API on mode switch.
    const cached = getCachedAskResult({
      projectId,
      normalizedQuestion: q,
      searchMode: next,
    });
    if (cached) {
      setResult(cached.result);
      setSubmittedQuestion(q);
      setFromSessionCache(true);
    } else {
      clearActiveAnswerContext();
      setSubmittedQuestion(q);
    }
    refreshCachedModesFor(q);
  }

  async function runAsk(
    searchMode: SearchMode,
    q: string,
  ): Promise<AskQuestionResult> {
    // Isolated request body — never previous answers, sources, plans, or cache.
    const requestBody = {
      question: q,
      projectId: customerId,
      searchMode,
      conversationMode: false as const,
    };
    try {
      const res = await fetch("/api/app/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data = (await res.json()) as {
        status?: string;
        answer?: string | null;
        reasoning?: string | null;
        message?: string | null;
        processAnswer?: ProcessAnswer | null;
        technicalDetails?: TechnicalDetails | null;
        compactTechnicalDetails?: CompactTechnicalDetails | null;
        entityGrounding?: EntityGroundingResult[];
        sources?: Array<{
          rank: number;
          title: string;
          sourceKey: string;
          knowledgeUnitType: string;
          objectType: string;
          objectName: string;
          subobjectName: string;
          snippet: string;
          score: number;
          exactScore: number;
          fulltextScore: number;
          vectorScore: number;
          evidenceRefs: string[];
          facts: string[];
          inferences: string[];
          tablesRead?: string[];
          tablesWritten?: string[];
          calledMethods?: string[];
          hardcodedValues?: string[];
          evidence?: AskQuestionResult["evidence"][number]["evidence"];
          confidence?: number | null;
        }>;
        retrievalMode?: string;
        searchedDocumentCount?: number;
        topScore?: number | null;
        vectorSearchActive?: boolean;
        model?: string;
        tokenUsage?: { input: number; output: number; embedding: number };
        estimatedCost?: number;
        warnings?: string[];
        indexPath?: string;
        retrievalSummary?: string;
        searchMode?: SearchMode;
        requestedSearchMode?: SearchMode;
        queryPlan?: QueryPlan | null;
        subqueryCount?: number;
        plannerFallback?: boolean;
        durationMs?: number;
        conversationMode?: false;
        domainProfileId?: string;
        promptKey?: string;
        promptVersion?: string;
        searchProfileId?: string;
        relevanceGate?: AskQuestionResult["relevanceGate"];
      };

      const evidence =
        data.sources?.map((s) => ({
          title: s.title,
          sourceKey: s.sourceKey,
          snippet: s.snippet,
          rank: s.rank,
          score: s.score,
          exactScore: s.exactScore,
          fulltextScore: s.fulltextScore,
          vectorScore: s.vectorScore,
          knowledgeUnitType: s.knowledgeUnitType,
          objectLabel: [s.objectType, s.objectName, s.subobjectName]
            .filter(Boolean)
            .join(" "),
          objectType: s.objectType,
          objectName: s.objectName,
          subobjectName: s.subobjectName,
          evidenceRefs: s.evidenceRefs,
          facts: s.facts,
          inferences: s.inferences,
          tablesRead: s.tablesRead,
          tablesWritten: s.tablesWritten,
          calledMethods: s.calledMethods,
          hardcodedValues: s.hardcodedValues,
          evidence: s.evidence,
          confidence: s.confidence,
        })) ?? [];

      const status: AskQuestionResult["status"] =
        data.status === "ok"
          ? "ok"
          : data.status === "insufficient"
            ? "insufficient"
            : "error";

      const relevanceGate = data.relevanceGate
        ? {
            answerability: data.relevanceGate.answerability,
            queryConcepts: data.relevanceGate.queryConcepts ?? [],
            matchedConcepts: data.relevanceGate.matchedConcepts ?? [],
            missingConcepts: data.relevanceGate.missingConcepts ?? [],
            supportingSourceIds: data.relevanceGate.supportingSourceIds ?? [],
            contradictingSourceIds:
              data.relevanceGate.contradictingSourceIds ?? [],
            similarButInsufficientSourceIds:
              data.relevanceGate.similarButInsufficientSourceIds ?? [],
            reason: data.relevanceGate.reason ?? "",
          }
        : null;

      return {
        status,
        answer: data.answer ?? null,
        reasoning: data.reasoning,
        processAnswer: data.processAnswer,
        technicalDetails: data.technicalDetails,
        compactTechnicalDetails: data.compactTechnicalDetails,
        entityGrounding: data.entityGrounding,
        relevanceGate,
        evidence,
        message:
          data.message ||
          data.retrievalSummary ||
          (status === "error" ? "Frage fehlgeschlagen." : ""),
        retrievalMode: data.retrievalMode,
        searchedDocumentCount: data.searchedDocumentCount,
        topScore: data.topScore,
        vectorSearchActive: data.vectorSearchActive,
        model: data.model,
        tokenUsage: data.tokenUsage,
        estimatedCost: data.estimatedCost,
        warnings: data.warnings,
        indexPath: data.indexPath,
        searchMode: data.searchMode,
        requestedSearchMode: data.requestedSearchMode,
        queryPlan: data.queryPlan,
        subqueryCount: data.subqueryCount,
        plannerFallback: data.plannerFallback,
        durationMs: data.durationMs,
        conversationMode: false,
        domainProfileId: data.domainProfileId,
        promptKey: data.promptKey,
        promptVersion: data.promptVersion,
        searchProfileId: data.searchProfileId,
      };
    } catch {
      return askQuestionAction({ question: q, customerId, searchMode });
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = normalizeAskQuestion(question);
    if (!q || !projectId) return;

    const submittedMode = mode;
    const seq = ++requestSeqRef.current;

    // New question = discard active answer context immediately (cache kept separately).
    setQuestion(q);
    setSubmittedQuestion(q);
    clearActiveAnswerContext();
    setFromSessionCache(false);

    startTransition(async () => {
      try {
        // Always a fresh isolated server run — never hydrate from session cache.
        const r = await runAsk(submittedMode, q);
        if (seq !== requestSeqRef.current) return; // stale response ignored

        putCachedAskResult({
          key: cacheKeyFromAskResult({
            projectId,
            sessionId: getSessionAskId(),
            normalizedQuestion: q,
            searchMode: submittedMode,
            result: r,
          }),
          result: r,
        });
        refreshCachedModesFor(q);
        setResult(r);
        setFromSessionCache(false);
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setApiError(
          err instanceof Error ? err.message : "Netzwerkfehler bei der Frage.",
        );
        setResult(null);
      }
    });
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <SearchModeToggle
          mode={mode}
          onChange={selectMode}
          disabled={pending}
          cachedModes={cachedModes}
        />
        <label className="label" htmlFor="ask-question">
          Was möchten Sie über Ihr System wissen?
        </label>
        <textarea
          id="ask-question"
          name="question"
          className="textarea min-h-[8.5rem] w-full text-base leading-relaxed sm:min-h-[10rem] sm:text-lg"
          placeholder="Ihre Frage …"
          value={question}
          onChange={(e) => {
            const v = e.target.value;
            setQuestion(v);
            setFromSessionCache(false);
            // Drafting a different question must not keep the previous answer visible.
            const norm = normalizeAskQuestion(v);
            if (norm !== submittedQuestion) {
              setResult(null);
              setApiError(null);
            } else if (norm && projectId) {
              const cached = getCachedAskResult({
                projectId,
                normalizedQuestion: norm,
                searchMode: mode,
              });
              if (cached) {
                setResult(cached.result);
                setFromSessionCache(true);
              }
            }
          }}
          disabled={pending}
          required
        />
        <button
          type="submit"
          className="btn btn-primary w-full sm:w-auto"
          disabled={pending || !question.trim() || !customerId}
          aria-busy={pending}
        >
          {pending ? "Wird gesucht …" : "Frage stellen"}
        </button>
        {!customerId ? (
          <p className="muted text-sm">
            Kein Projekt zugeordnet — Fragen sind nicht möglich.
          </p>
        ) : null}
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
          <p className="muted text-xs">
            Isolierte Anfrage — ohne Kontext vorheriger Fragen …
          </p>
        </div>
      ) : null}

      {apiError ? (
        <InlineError title="Anfrage fehlgeschlagen" message={apiError} />
      ) : null}

      {!pending && !result && !apiError ? (
        <EmptyState
          title={
            normalizeAskQuestion(question) && cachedModes.size > 0
              ? "Kein Ergebnis in diesem Suchmodus"
              : "Noch keine Frage"
          }
          message={
            normalizeAskQuestion(question) && cachedModes.size > 0
              ? "Für exakt diese Frage liegt in einem anderen Suchmodus ein gespeichertes Ergebnis vor. Stellen Sie die Frage erneut in diesem Modus, oder schalten Sie oben um."
              : "Stellen Sie eine Frage zu Ihrem System. Jede Frage wird isoliert beantwortet — ohne Chat-Verlauf."
          }
        />
      ) : null}

      {!pending && result?.status === "error" ? (
        <section className="space-y-3">
          {fromSessionCache ? (
            <p className="muted text-xs">
              Gespeichertes Ergebnis für exakt diese Frage und diesen Suchmodus
              {submittedQuestion
                ? ` · ${searchModeLabel(result.searchMode ?? mode)}`
                : ""}
            </p>
          ) : null}
          <InlineError title="Frage nicht möglich" message={result.message} />
          {result.technicalDetails ? (
            <TechnicalDetailsBlock
              details={result.technicalDetails}
              retrievalMode={result.retrievalMode}
              topScore={result.topScore}
              vectorSearchActive={result.vectorSearchActive}
              searchedDocumentCount={result.searchedDocumentCount}
            />
          ) : null}
          {result.evidence.length ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">
                Retrieval-Treffer (ohne fertige Antwort)
              </h3>
              {result.evidence.map((ev, i) => (
                <SourceCard
                  key={`${ev.sourceKey ?? ev.title}-${i}`}
                  ev={ev}
                  index={i}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {!pending &&
      (result?.status === "ok" || result?.status === "insufficient") ? (
        <section className="space-y-3 sm:space-y-4">
          {fromSessionCache ? (
            <p className="muted text-xs">
              Gespeichertes Ergebnis für exakt diese Frage und diesen Suchmodus
              · erneut „Frage stellen“ startet eine isolierte Neu-Berechnung.
            </p>
          ) : null}

          <ProcessAnswerBlock
            process={result.processAnswer}
            fallbackAnswer={result.answer}
            relevanceGate={result.relevanceGate}
            status={result.status}
          />

          <SearchModeSummary result={result} />

          {result.searchMode === "planned_rag" && result.queryPlan ? (
            <SearchPlanBlock plan={result.queryPlan} />
          ) : null}

          {result.status !== "insufficient" ? (
            <CompactTechnicalDetailsBlock
              compact={result.compactTechnicalDetails}
              entityGrounding={result.entityGrounding}
              rawDetails={result.technicalDetails}
              retrievalMode={result.retrievalMode}
              topScore={result.topScore}
              vectorSearchActive={result.vectorSearchActive}
              searchedDocumentCount={result.searchedDocumentCount}
            />
          ) : null}

          {result.warnings?.length ? (
            <ul className="list-disc space-y-1 pl-4 text-xs text-[var(--muted)]">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}

          {result.status === "insufficient" ? (
            result.evidence.length ? (
              <details className="panel compact group">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">
                  Ähnliche Treffer
                  <span className="ml-2 text-xs font-normal text-[var(--muted)]">
                    (nicht ausreichend · aufklappen)
                  </span>
                </summary>
                <div className="space-y-2 border-t border-[var(--border)] px-4 py-3">
                  <p className="text-xs text-[var(--muted)]">
                    Diese Treffer sind thematisch ähnlich, belegen die Frage
                    aber nicht ausreichend — sie fließen nicht in die
                    Prozessantwort ein.
                  </p>
                  {result.evidence.map((ev, i) => (
                    <SourceCard
                      key={`${ev.sourceKey ?? ev.title}-${i}`}
                      ev={ev}
                      index={i}
                      insufficientLabel
                    />
                  ))}
                </div>
              </details>
            ) : null
          ) : (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Quellen</h3>
              {result.evidence.length ? (
                result.evidence.map((ev, i) => (
                  <SourceCard
                    key={`${ev.sourceKey ?? ev.title}-${i}`}
                    ev={ev}
                    index={i}
                  />
                ))
              ) : (
                <p className="muted text-sm">Keine Belege geliefert.</p>
              )}
            </div>
          )}

          {result.model ? (
            <p className="text-xs text-[var(--muted)]">Modell: {result.model}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
