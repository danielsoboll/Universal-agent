"use client";

import { useState } from "react";
import type {
  HardcodedMaterialCard,
  HardcodedValueAnswerView,
} from "@/lib/knowledge/hardcodedValueInventory";

function MaterialCard({ card }: { card: HardcodedMaterialCard }) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[1.05rem] font-semibold tracking-tight break-all">
          Material {card.material_number}
        </h3>
        <span className="text-[0.75rem] text-[var(--muted)]">
          {card.occurrence_count} Fundstelle
          {card.occurrence_count === 1 ? "" : "n"}
        </span>
      </header>
      <dl className="mt-2 space-y-1.5 text-[0.875rem] leading-relaxed">
        <div>
          <dt className="text-[0.75rem] text-[var(--muted)]">Prozess</dt>
          <dd>
            {card.process_label ??
              "Fachlicher Prozess aus den vorliegenden Codebelegen noch nicht eindeutig ableitbar"}
          </dd>
        </div>
        <div>
          <dt className="text-[0.75rem] text-[var(--muted)]">Bedingung</dt>
          <dd>
            {card.condition_summary ??
              "Das Material wird im Quellcode mit einem fest hinterlegten Wert verglichen."}
          </dd>
        </div>
        <div>
          <dt className="text-[0.75rem] text-[var(--muted)]">Auswirkung</dt>
          <dd>
            {card.effect_summary ??
              "Bei Treffer greift die im jeweiligen Programm hinterlegte Sonderlogik."}
          </dd>
        </div>
        <div>
          <dt className="text-[0.75rem] text-[var(--muted)]">Status</dt>
          <dd>{card.evidence_status}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[0.75rem] text-[var(--muted)]">
        Fundstellen:{" "}
        {[
          ...new Set(
            (card.occurrences ?? [])
              .filter((o) => o.active_code)
              .map((o) =>
                o.unit_name && o.unit_name !== o.object_name
                  ? `${o.object_name}->${o.unit_name}`
                  : o.object_name,
              ),
          ),
        ]
          .slice(0, 6)
          .join(", ") || "—"}
      </p>
    </article>
  );
}

function Section({
  title,
  cards,
}: {
  title: string;
  cards: HardcodedMaterialCard[] | null | undefined;
}) {
  if (!cards?.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
        {title} ({cards.length})
      </h3>
      <div className="space-y-2">
        {cards.map((c) => (
          <MaterialCard key={c.material_number_internal} card={c} />
        ))}
      </div>
    </div>
  );
}

export function HardcodedValueAnswerPanel({
  view,
  showSummary = true,
}: {
  view: HardcodedValueAnswerView;
  /** When false, only material cards (summary lives in Prozessantwort). */
  showSummary?: boolean;
}) {
  const [techOpen, setTechOpen] = useState(false);
  const s = view.summary ?? {
    text: "",
    unique_material_count: 0,
    active_occurrence_count: 0,
    comment_only_count: 0,
    excluded_literal_count: 0,
    units_scanned: 0,
    units_with_matnr_context: 0,
  };
  const materials = view.materials ?? [];
  const multiUse = view.multi_use ?? [];
  const commentOrUnclear = view.comment_or_unclear ?? [];
  const missingInformation = view.missing_information ?? [];
  const excludedSample = view.excluded_sample ?? [];

  return (
    <section className="panel compact space-y-4 p-4 sm:p-5">
      <h2 className="text-base font-semibold tracking-tight">
        {showSummary ? "Hart codierte Werte" : "Materialnummern im Detail"}
      </h2>

      {showSummary ? (
        <div className="space-y-2">
          <p className="text-sm leading-relaxed sm:text-[0.95rem]">{s.text}</p>
          <ul className="grid grid-cols-2 gap-2 text-[0.8125rem] sm:grid-cols-3">
            <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
              <span className="block text-[var(--muted)]">Materialnummern</span>
              <span className="font-semibold tabular-nums">
                {s.unique_material_count}
              </span>
            </li>
            <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
              <span className="block text-[var(--muted)]">Aktive Fundstellen</span>
              <span className="font-semibold tabular-nums">
                {s.active_occurrence_count}
              </span>
            </li>
            <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
              <span className="block text-[var(--muted)]">Codeeinheiten</span>
              <span className="font-semibold tabular-nums">{s.units_scanned}</span>
            </li>
            <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
              <span className="block text-[var(--muted)]">MATNR-Kontext</span>
              <span className="font-semibold tabular-nums">
                {s.units_with_matnr_context}
              </span>
            </li>
            <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
              <span className="block text-[var(--muted)]">Nur Kommentar</span>
              <span className="font-semibold tabular-nums">
                {s.comment_only_count}
              </span>
            </li>
            <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
              <span className="block text-[var(--muted)]">Ausgeschlossen</span>
              <span className="font-semibold tabular-nums">
                {s.excluded_literal_count}
              </span>
            </li>
          </ul>
        </div>
      ) : (
        <p className="text-xs text-[var(--muted)]">
          Je Materialnummer: Prozessbezug, Bedingung, Auswirkung und Fundstellen
          im Quellcode.
        </p>
      )}

      <Section title="Materialnummern" cards={materials} />
      <Section title="Mehrfach verwendet" cards={multiUse} />
      <Section
        title="Kommentare / unklare Kandidaten"
        cards={commentOrUnclear}
      />

      {materials.length === 0 &&
      commentOrUnclear.length === 0 &&
      s.unique_material_count === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          Im aktuell verarbeiteten Quellcode wurden keine eindeutig als
          Materialnummern belegten hart codierten Werte gefunden.
        </p>
      ) : null}

      {missingInformation.length > 0 ? (
        <article className="rounded-xl border border-dashed border-[var(--border)] p-3">
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Fehlende Informationen
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[0.8125rem] text-[var(--muted)]">
            {missingInformation.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </article>
      ) : null}

      <div>
        <button
          type="button"
          className="text-[0.875rem] font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={() => setTechOpen((v) => !v)}
          aria-expanded={techOpen}
        >
          {techOpen ? "▾" : "▸"} Technische Fundstellen anzeigen
        </button>
        {techOpen ? (
          <div className="mt-2 space-y-3 text-[0.8125rem] text-[var(--muted)]">
            {[...materials, ...commentOrUnclear].map((m) => (
              <div key={`tech:${m.material_number_internal}`}>
                <p className="font-medium text-[var(--fg)]">
                  {m.material_number}
                </p>
                <ul className="mt-1 space-y-1.5">
                  {(m.occurrences ?? []).slice(0, 12).map((o, i) => (
                    <li
                      key={`${o.source_key}:${o.line_number}:${i}`}
                      className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5"
                    >
                      <p className="break-all text-[var(--fg)]">
                        {o.object_name}
                        {o.unit_name && o.unit_name !== o.object_name
                          ? `->${o.unit_name}`
                          : ""}
                        {o.line_number != null ? `:${o.line_number}` : ""}
                      </p>
                      <p className="mt-0.5 break-all font-mono text-[0.7rem]">
                        {o.snippet}
                      </p>
                      <p className="mt-0.5 break-all text-[0.7rem]">
                        {o.source_key}
                        {o.comment_only ? " · nur Kommentar" : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {excludedSample.length > 0 ? (
              <div>
                <p className="font-medium text-[var(--fg)]">
                  Ausgeschlossene Literale (Stichprobe)
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {excludedSample.slice(0, 30).map((e, i) => (
                    <li key={`${e.literal}:${e.reason}:${i}`} className="break-all">
                      {e.literal} — {e.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
