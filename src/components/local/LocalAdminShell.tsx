"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { localSignOut } from "@/actions/localAuth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";

const ADMIN_LINKS = [
  { href: "/admin", label: "Extraktion" },
  { href: "/admin/project", label: "Projekt" },
  { href: "/admin/users", label: "Benutzer" },
];

const STORAGE_SAP = "ga_admin_module_sap";
const STORAGE_COMPACT = "ga_admin_sap_hero_compact";

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1" || v === "true";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function SapToggle({
  sap,
  onChange,
}: {
  sap: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="badge cursor-pointer gap-1 text-[0.6rem] select-none">
      <input
        type="checkbox"
        className="size-3 accent-amber-500"
        checked={sap}
        onChange={(e) => onChange(e.target.checked)}
        aria-label="SAP-Modul aktiv"
      />
      SAP
    </label>
  );
}

export function LocalAdminShell({
  email,
  children,
}: {
  email?: string | null;
  children: React.ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const [sap, setSap] = useState(true);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    setSap(readBool(STORAGE_SAP, true));
    setCompact(readBool(STORAGE_COMPACT, false));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    writeBool(STORAGE_SAP, sap);
  }, [sap, ready]);

  useEffect(() => {
    if (!ready) return;
    writeBool(STORAGE_COMPACT, compact);
  }, [compact, ready]);

  useEffect(() => {
    if (sap && !compact) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
    document.body.style.overflow = "";
    return undefined;
  }, [sap, compact]);

  const setSapMode = (next: boolean) => {
    setSap(next);
    if (next) setCompact(false);
  };

  const showHero = ready && sap && !compact;
  const showCompactTitle = ready && sap && compact;

  return (
    <div className="min-h-screen pb-safe">
      {showHero ? (
        <div className="sap-z-agent-hero" role="dialog" aria-modal="true">
          <div className="sap-z-agent-hero-bar">
            <span className="badge text-[0.6rem]">Admin</span>
            <SapToggle sap={sap} onChange={setSapMode} />
          </div>
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
      ) : null}

      <header className="app-header pt-safe relative z-20">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-3 py-2.5 sm:px-6 sm:py-4">
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            {showCompactTitle ? (
              <button
                type="button"
                className="sap-z-agent-title sap-z-agent-title--compact"
                onClick={() => setCompact(false)}
                title="SAP Z-Agent vergrößern"
              >
                SAP Z-Agent
              </button>
            ) : sap ? (
              <Link
                href="/admin"
                className="muted text-xs font-medium sm:text-sm"
              >
                General
              </Link>
            ) : (
              <BrandMark size={28} withName compactName={false} href="/admin" />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <span className="badge text-[0.6rem]">Admin</span>
            <SapToggle sap={sap} onChange={setSapMode} />
            <span className="muted hidden max-w-[9rem] truncate text-xs lg:inline">
              {email}
            </span>
            <ThemeToggle />
            <form action={localSignOut}>
              <button
                className="btn btn-secondary px-2 text-xs sm:px-2.5 sm:text-sm"
                type="submit"
              >
                Abmelden
              </button>
            </form>
          </div>
        </div>
        <nav
          className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-3 pb-2.5 sm:px-6"
          aria-label="Admin-Navigation"
        >
          {ADMIN_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-pill shrink-0">
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="page-shell mx-auto w-full max-w-6xl px-3 py-4 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
