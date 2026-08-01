"use client";

import { useEffect, useState } from "react";

const STORAGE_COMPACT = "ga_sap_hero_compact";

/**
 * SAP-Projekt-Branding: große Gold-Überschrift, Klick verkleinert in die Kopfzeile.
 * Gesteuert über product_module=sap am Kundenprojekt (nicht per freiem Toggle).
 */
export function SapProjectBrand({
  compactSlot,
}: {
  /** Wenn true: nur kompakte Titelzeile (für Header). */
  compactSlot?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    try {
      setCompact(localStorage.getItem(STORAGE_COMPACT) === "1");
    } catch {
      /* ignore */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE_COMPACT, compact ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [compact, ready]);

  useEffect(() => {
    if (!compactSlot && ready && !compact) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
    return undefined;
  }, [compact, compactSlot, ready]);

  if (!ready) return null;

  if (compactSlot) {
    if (!compact) return null;
    return (
      <button
        type="button"
        className="sap-z-agent-title sap-z-agent-title--compact"
        onClick={() => setCompact(false)}
        title="SAP Z-Agent vergrößern"
      >
        SAP Z-Agent
      </button>
    );
  }

  if (compact) return null;

  return (
    <div className="sap-z-agent-hero" role="dialog" aria-modal="true">
      <button
        type="button"
        className="sap-z-agent-title sap-z-agent-title--hero"
        onClick={() => setCompact(true)}
        title="Klicken zum Verkleinern"
      >
        SAP Z-Agent
      </button>
      <p className="sap-z-agent-hint">Tippen zum Verkleinern</p>
    </div>
  );
}
