"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BackNavLink } from "@/components/ui/BackNavLink";

function withCustomer(href: string, customer: string | null): string {
  if (!customer) return href;
  const url = new URL(href, "http://local");
  url.searchParams.set("customer", customer);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

/**
 * Clear admin back navigation:
 * - Dashboard → Startseite
 * - Step detail → Dashboard (with customer)
 * - Other admin pages → Dashboard
 */
function AdminBackNavInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const customer = searchParams.get("customer");

  const onDashboard =
    pathname === "/admin" ||
    pathname === "/admin/dashboard" ||
    pathname.startsWith("/admin/dashboard/");

  if (onDashboard) {
    return <BackNavLink href="/" label="Zur Startseite" />;
  }

  if (pathname.startsWith("/admin/steps/")) {
    return (
      <BackNavLink
        href={withCustomer("/admin/dashboard", customer)}
        label="Zum Dashboard"
      />
    );
  }

  return (
    <BackNavLink
      href={withCustomer("/admin/dashboard", customer)}
      label="Zum Dashboard"
    />
  );
}

export function AdminBackNav() {
  return (
    <Suspense fallback={<div className="h-11" aria-hidden />}>
      <AdminBackNavInner />
    </Suspense>
  );
}
