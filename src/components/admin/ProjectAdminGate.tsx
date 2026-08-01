"use client";

import {
  useCallback,
  useState,
  type ReactNode,
  type MouseEvent,
} from "react";
import { PROJECT_ADMIN_REQUIRED_HINT } from "@/lib/onboarding/permissions";

export { PROJECT_ADMIN_REQUIRED_HINT };

/**
 * Action control for Hauptschritte: Projekt-Admin runs the action;
 * Projekt-Benutzer can press and get a clear hint (not silent disable).
 */
export function ProjectAdminGateButton({
  canRun,
  onRun,
  className,
  children,
  type = "button",
  disabled,
  hintClassName,
}: {
  canRun: boolean;
  onRun?: () => void | Promise<void>;
  className?: string;
  children: ReactNode;
  type?: "button" | "submit";
  disabled?: boolean;
  hintClassName?: string;
}) {
  const [hint, setHint] = useState(false);

  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (canRun) {
        if (!onRun) return;
        void onRun();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setHint(true);
    },
    [canRun, onRun],
  );

  return (
    <div className="min-w-0">
      <button
        type={canRun ? type : "button"}
        className={className}
        disabled={canRun ? disabled : false}
        onClick={onClick}
        aria-describedby={hint && !canRun ? "project-admin-hint" : undefined}
      >
        {children}
      </button>
      {hint && !canRun ? (
        <p
          id="project-admin-hint"
          className={
            hintClassName ??
            "mt-1.5 text-[0.9375rem] leading-snug text-[var(--warning)]"
          }
          role="status"
        >
          {PROJECT_ADMIN_REQUIRED_HINT}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Link-styled control that shows the Projekt-Admin hint instead of navigating
 * when the user cannot mutate setup.
 */
export function ProjectAdminGateLink({
  canRun,
  href,
  className,
  children,
}: {
  canRun: boolean;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const [hint, setHint] = useState(false);

  if (canRun) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        className={className}
        onClick={() => setHint(true)}
      >
        {children}
      </button>
      {hint ? (
        <p
          className="mt-1.5 text-[0.9375rem] leading-snug text-[var(--warning)]"
          role="status"
        >
          {PROJECT_ADMIN_REQUIRED_HINT}
        </p>
      ) : null}
    </div>
  );
}
