"use client";

import { useState } from "react";
import { PwaInstallPanel } from "@/components/pwa/PwaInstallPanel";

export function HomePwaHelp() {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="panel compact"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="flex items-center justify-between gap-2">
          Zum Home-Bildschirm hinzufügen
          <span className="muted font-normal" aria-hidden>
            {open ? "▴" : "▾"}
          </span>
        </span>
        <span className="muted mt-1 block text-xs font-normal">
          Optional — Anleitung für iPhone, iPad und Android
        </span>
      </summary>
      <div className="border-t border-[var(--border)] px-4 py-4">
        <PwaInstallPanel />
      </div>
    </details>
  );
}
