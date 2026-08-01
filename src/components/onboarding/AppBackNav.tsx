"use client";

import { usePathname } from "next/navigation";
import { BackNavLink } from "@/components/ui/BackNavLink";

/** Ein Zurück-Link im Anwenderbereich: Unterseiten → Übersicht; Übersicht → Start. */
export function AppBackNav() {
  const pathname = usePathname();
  const onOverview = pathname === "/app" || pathname === "/app/";

  if (onOverview) {
    return <BackNavLink href="/" label="Zur Startseite" />;
  }

  return <BackNavLink href="/app" label="Zur Übersicht" />;
}
