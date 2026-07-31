"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

const ADMIN_LINKS = [
  { href: "/admin/dashboard", label: "Dashboard" },
  { href: "/admin/setup", label: "Setup" },
  { href: "/admin/checklist", label: "Fahrplan" },
  { href: "/admin/sources", label: "Quellen" },
  { href: "/admin/uploads", label: "Uploads" },
  { href: "/admin/pipeline", label: "Pipeline" },
  { href: "/admin/quality", label: "Qualität" },
  { href: "/admin/users", label: "Benutzer" },
];

function withCustomer(href: string, customer: string | null): string {
  if (!customer) return href;
  const url = new URL(href, "http://local");
  url.searchParams.set("customer", customer);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function AdminNavInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const customer = searchParams.get("customer");
  const [open, setOpen] = useState(false);
  const active =
    ADMIN_LINKS.find(
      (l) => pathname === l.href || pathname.startsWith(`${l.href}/`),
    ) ?? ADMIN_LINKS[0];

  return (
    <>
      <div className="border-b border-[var(--border)] px-4 pb-3 md:hidden">
        <button
          type="button"
          className="btn btn-secondary w-full justify-between"
          aria-expanded={open}
          aria-controls="admin-mobile-nav"
          onClick={() => setOpen((v) => !v)}
        >
          <span>Menü · {active?.label}</span>
          <span aria-hidden>{open ? "▴" : "▾"}</span>
        </button>
        {open ? (
          <nav
            id="admin-mobile-nav"
            className="mt-2 grid gap-1 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-2"
            aria-label="Admin-Navigation"
          >
            {ADMIN_LINKS.map((l) => {
              const href = withCustomer(l.href, customer);
              const isActive =
                pathname === l.href || pathname.startsWith(`${l.href}/`);
              return (
                <Link
                  key={l.href}
                  href={href}
                  onClick={() => setOpen(false)}
                  className={`rounded-lg px-3 py-2.5 text-sm font-medium ${
                    isActive
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "text-[var(--muted)]"
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </div>

      <nav
        className="admin-nav-scroll mx-auto hidden w-full max-w-6xl gap-1 overflow-x-auto px-4 pb-3 md:flex"
        aria-label="Admin-Navigation"
      >
        {ADMIN_LINKS.map((l) => {
          const href = withCustomer(l.href, customer);
          const isActive =
            pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <Link
              key={l.href}
              href={href}
              className={`nav-pill shrink-0 ${isActive ? "nav-pill-active" : ""}`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

export function AdminNav() {
  return (
    <Suspense fallback={<div className="h-10 border-b border-[var(--border)]" />}>
      <AdminNavInner />
    </Suspense>
  );
}
