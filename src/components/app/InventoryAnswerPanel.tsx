"use client";

import { useState } from "react";
import type {
  InventoryAnswerView,
  InventoryCardItem,
} from "@/lib/knowledge/inventoryAggregation";

function Card({ item }: { item: InventoryCardItem }) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[1.05rem] font-semibold tracking-tight">
          {item.output_type}
        </h3>
        <span className="text-[0.75rem] text-[var(--muted)]">
          {item.medium
            ? `${item.medium} · ${item.medium_text}`
            : item.medium_text}
        </span>
      </header>
      {item.description ? (
        <p className="mt-0.5 text-[0.875rem] text-[var(--muted)]">
          {item.description}
        </p>
      ) : null}
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[0.8125rem]">
        <div>
          <dt className="text-[var(--muted)]">Programm</dt>
          <dd className="font-medium break-all">{item.program ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Routine</dt>
          <dd className="font-medium break-all">{item.routine ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Message Type</dt>
          <dd className="font-medium break-all">{item.message_type ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">IDoc-Basistyp</dt>
          <dd className="font-medium break-all">{item.idoc_type ?? "—"}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-[var(--muted)]">Erweiterung</dt>
          <dd className="font-medium break-all">
            {item.idoc_extension ?? "—"}
          </dd>
        </div>
      </dl>
      <p
        className={`mt-2 text-[0.8125rem] ${
          item.chain_complete
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-[var(--muted)]"
        }`}
      >
        {item.evidence_status}
      </p>
    </article>
  );
}

export function InventoryAnswerPanel({
  view,
}: {
  view: InventoryAnswerView;
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const sel = view.summary.application_selection;

  return (
    <section className="panel compact space-y-4 p-4 sm:p-5">
      <h2 className="text-base font-semibold tracking-tight">
        Inventar / Aggregation
      </h2>

      {/* A. Kurzzusammenfassung */}
      <div className="space-y-2">
        <p className="text-sm leading-relaxed sm:text-[0.95rem]">
          {view.summary.text}
        </p>
        <p className="text-[0.8125rem] text-[var(--muted)]">
          {sel.reason}
        </p>
        <ul className="grid grid-cols-2 gap-2 text-[0.8125rem] sm:grid-cols-3">
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Anwendung</span>
            <span className="font-semibold">
              {view.summary.selected_application ?? "—"} ({sel.confidence})
            </span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Gesamt</span>
            <span className="font-semibold tabular-nums">
              {view.summary.total_output_types}
            </span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Medium 6 / EDI</span>
            <span className="font-semibold tabular-nums">
              {view.summary.edi_medium_count}
            </span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Message Type</span>
            <span className="font-semibold tabular-nums">
              {view.summary.resolved_message_type_count}
            </span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">IDoc-Basistyp</span>
            <span className="font-semibold tabular-nums">
              {view.summary.resolved_idoc_type_count}
            </span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Unvollständig</span>
            <span className="font-semibold tabular-nums">
              {view.summary.unresolved_chain_count}
            </span>
          </li>
        </ul>
      </div>

      {/* B+C. EDI cards (resolved first via backend sort) */}
      <div className="space-y-2">
        <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
          EDI-/IDoc-Nachrichten (Medium 6)
        </h3>
        {view.filtered_items.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            Keine Outputarten mit Medium 6 (EDI) in dieser Anwendung.
          </p>
        ) : (
          <div className="space-y-2">
            {view.filtered_items.map((item) => (
              <Card
                key={`${item.output_type}|${item.medium}|${item.program}`}
                item={item}
              />
            ))}
          </div>
        )}
      </div>

      {/* D. Unresolved hint (already in cards; short list) */}
      {view.unresolved_items.length > 0 ? (
        <div className="space-y-1">
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Nicht vollständig aufgelöste EDI-Ketten
          </h3>
          <ul className="list-disc space-y-0.5 pl-5 text-[0.8125rem] text-[var(--muted)]">
            {view.unresolved_items.map((u) => (
              <li key={u.output_type}>
                {u.output_type}
                {u.description ? ` — ${u.description}` : ""}: {u.evidence_status}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* E. Collapsed other media */}
      {view.other_items.length > 0 ? (
        <div>
          <button
            type="button"
            className="text-[0.875rem] font-medium text-[var(--accent)] underline-offset-2 hover:underline"
            onClick={() => setOtherOpen((v) => !v)}
            aria-expanded={otherOpen}
          >
            {otherOpen ? "▾" : "▸"} Weitere Nachrichtenarten der Anwendung (
            {view.other_items.length})
          </button>
          {otherOpen ? (
            <div className="mt-2 space-y-2">
              {view.other_items.map((item) => (
                <Card
                  key={`other-${item.output_type}|${item.medium}`}
                  item={item}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {view.sources.length > 0 ? (
        <div>
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Quellen
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[0.75rem] text-[var(--muted)]">
            {view.sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
