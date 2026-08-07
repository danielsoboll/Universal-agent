"use client";

import { useState } from "react";
import type {
  ProcessAnswerView,
  TechnicalObjectChip,
} from "@/lib/knowledge/askOrchestration/relevanceGateTypes";

function Chip({ item }: { item: TechnicalObjectChip }) {
  const label = item.unit_name
    ? `${item.object_name}->${item.unit_name}`
    : item.object_name;
  return (
    <li className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[0.75rem]">
      <span className="text-[var(--muted)]">{item.object_type}</span>{" "}
      <span className="font-medium break-all">{label}</span>
    </li>
  );
}

function ChipList({
  title,
  items,
}: {
  title: string;
  items: TechnicalObjectChip[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
        {title}
      </h3>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <Chip
            key={`${item.object_type}|${item.object_name}|${item.unit_name}|${i}`}
            item={item}
          />
        ))}
      </ul>
    </div>
  );
}

export function ProcessAnswerPanel({ view }: { view: ProcessAnswerView }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  return (
    <section className="panel compact space-y-4 p-4 sm:p-5">
      <h2 className="text-base font-semibold tracking-tight">
        Prozesserklärung
      </h2>

      <p className="text-sm leading-relaxed sm:text-[0.95rem]">{view.summary}</p>

      <ChipList title="Steuernder technischer Anker" items={view.technical_anchors} />

      {view.process_steps.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Fachlicher Ablauf
          </h3>
          <ol className="space-y-3">
            {view.process_steps.map((step, i) => (
              <li
                key={`step-${i}`}
                className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"
              >
                <p className="text-sm leading-relaxed">
                  <span className="mr-1.5 font-semibold text-[var(--muted)]">
                    {i + 1}.
                  </span>
                  {step.text}
                </p>
                {step.technical_refs.length > 0 ? (
                  <p className="mt-1.5 text-[0.75rem] text-[var(--muted)]">
                    Technischer Beleg: {step.technical_refs.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <ChipList
        title="Technische Fundstellen (ohne Inhaltsanalyse)"
        items={view.technical_findings}
      />
      <ChipList
        title="Beteiligte Klassen / Programme"
        items={view.participants}
      />
      <ChipList
        title="Tabellen / Felder / Konfiguration"
        items={view.tables_fields_config}
      />

      {view.open_points.length > 0 ? (
        <div>
          <h3 className="text-[0.875rem] font-medium text-[var(--muted)]">
            Noch offen
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[0.8125rem] text-[var(--muted)]">
            {view.open_points.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </div>
      ) : null}

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
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[0.75rem] text-[var(--muted)]">
            {view.evidence.map((e) => (
              <li key={e.source_key} className="break-all">
                [{e.tier}] {e.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
