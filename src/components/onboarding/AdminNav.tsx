"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

const ADMIN_LINKS = [
  { href: "/admin/dashboard", label: "Dashboard" },
  { href: "/admin/extraction", label: "Datenimport" },
  { href: "/admin/setup", label: "Setup" },
  { href: "/admin/sources", label: "Quellen" },
  { href: "/admin/uploads", label: "Uploads" },
  { href: "/admin/pipeline", label: "Pipeline" },
  { href: "/admin/quality", label: "Qualität" },
  { href: "/admin/users", label: "Anwender" },
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
      <div className="border-b border-[var(--border)] px-3 pb-1 md:hidden">
        <button
          type="button"
          className="btn btn-secondary btn-quiet w-full justify-between min-h-11 py-1 text-sm font-medium"
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
            className="mt-0.5 grid gap-0 rounded-md border border-[var(--border)] bg-[var(--panel)] p-0.5"
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
                  className={`flex min-h-11 items-center rounded px-2.5 py-1.5 text-sm font-medium ${
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
        className="admin-nav-scroll mx-auto hidden w-full max-w-6xl gap-0.5 overflow-x-auto px-4 pb-1.5 md:flex"
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
              className={`nav-pill shrink-0 px-3 py-1.5 text-sm ${isActive ? "nav-pill-active" : ""}`}
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
    <Suspense fallback={<div className="h-8 border-b border-[var(--border)]" />}>
      <AdminNavInner />
    </Suspense>
  );
}
