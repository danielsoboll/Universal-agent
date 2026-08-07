"use client";

import { useState } from "react";
import type {
  EntityListAnswerView,
  EntityListCardItem,
} from "@/lib/knowledge/entityListAggregation";

function MethodChips({ methods }: { methods: string[] }) {
  if (methods.length === 0) {
    return <span className="text-[0.8125rem] text-[var(--muted)]">—</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {methods.map((m) => (
        <li
          key={m}
          className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[0.75rem] font-medium"
        >
          {m}
        </li>
      ))}
    </ul>
  );
}

function EntityCard({ item }: { item: EntityListCardItem }) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[1.05rem] font-semibold tracking-tight break-all">
          {item.entity_name}
        </h3>
        <span className="text-[0.75rem] text-[var(--muted)]">
          {item.role_label}
        </span>
      </header>
      <p className="mt-1 text-[0.875rem] leading-relaxed text-[var(--muted)]">
        {item.rationale}
      </p>
      <div className="mt-2 space-y-1">
        <p className="text-[0.75rem] text-[var(--muted)]">Methoden</p>
        <MethodChips methods={item.matched_methods} />
      </div>
      <p className="mt-2 text-[0.8125rem]">
        {item.hit_kind === "direct"
          ? `Direkter Treffer${item.graph_distance != null ? ` (Distanz ${item.graph_distance})` : ""}`
          : `Graphpfad${item.graph_distance != null ? ` (Distanz ${item.graph_distance})` : ""}`}
        {" · "}
        <span className="text-[var(--muted)]">{item.evidence_status}</span>
      </p>
      {item.context_nodes.length > 0 ? (
        <p className="mt-1 text-[0.75rem] text-[var(--muted)]">
          Kontext:{" "}
          {item.context_nodes
            .map((c) => `${c.kind}:${c.name}`)
            .join(", ")}
        </p>
      ) : null}
    </article>
  );
}

function Section({
  title,
  items,
}: {
  title: string;
  items: EntityListCardItem[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
        {title} ({items.length})
      </h3>
      <div className="space-y-2">
        {items.map((item) => (
          <EntityCard key={item.entity_name} item={item} />
        ))}
      </div>
    </div>
  );
}

export function EntityListAnswerPanel({
  view,
}: {
  view: EntityListAnswerView;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const s = view.summary;

  return (
    <section className="panel compact space-y-4 p-4 sm:p-5">
      <h2 className="text-base font-semibold tracking-tight">
        Entitätenliste
      </h2>

      <div className="space-y-2">
        <p className="text-sm leading-relaxed sm:text-[0.95rem]">{s.text}</p>
        <ul className="grid grid-cols-2 gap-2 text-[0.8125rem] sm:grid-cols-3">
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Typ</span>
            <span className="font-semibold">{s.requested_entity_type}</span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Thema</span>
            <span className="font-semibold">{s.topic_label}</span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Roh-Treffer</span>
            <span className="font-semibold tabular-nums">{s.raw_hit_count}</span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Eindeutig</span>
            <span className="font-semibold tabular-nums">
              {s.unique_entity_count}
            </span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Primär</span>
            <span className="font-semibold tabular-nums">{s.primary_count}</span>
          </li>
          <li className="rounded-lg border border-[var(--border)] px-2 py-1.5">
            <span className="block text-[var(--muted)]">Unterstützend</span>
            <span className="font-semibold tabular-nums">
              {s.supporting_count}
            </span>
          </li>
        </ul>
      </div>

      <Section title="Primäre Treffer" items={view.primary_items} />
      <Section title="Unterstützende Treffer" items={view.supporting_items} />
      <Section title="Unklare Treffer" items={view.unclear_items} />

      <div>
        <button
          type="button"
          className="text-[0.875rem] font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={() => setEvidenceOpen((v) => !v)}
          aria-expanded={evidenceOpen}
        >
          {evidenceOpen ? "▾" : "▸"} Technische Belege anzeigen
        </button>
        {evidenceOpen ? (
          <div className="mt-2 space-y-3 text-[0.8125rem] text-[var(--muted)]">
            {[
              ...view.primary_items,
              ...view.supporting_items,
              ...view.unclear_items,
            ].map((item) => (
              <div key={`ev-${item.entity_name}`}>
                <p className="font-medium text-[var(--fg)]">{item.entity_name}</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                  {item.evidence_sources.map((src) => (
                    <li key={src} className="break-all">
                      {src}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {view.filtered_out_evidence.length > 0 ? (
              <div>
                <p className="font-medium text-[var(--fg)]">
                  Ausgefilterte Nicht-Haupttreffer
                </p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                  {view.filtered_out_evidence.map((f) => (
                    <li key={`${f.kind}:${f.name}`}>
                      {f.kind}:{f.name} — {f.note}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {view.sources.length > 0 ? (
              <div>
                <p className="font-medium text-[var(--fg)]">Quellen</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                  {view.sources.map((s) => (
                    <li key={s}>{s}</li>
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
