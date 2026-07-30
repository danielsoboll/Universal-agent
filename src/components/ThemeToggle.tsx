"use client";

import { useEffect, useState } from "react";
import {
  applyDarkClass,
  setStoredTheme,
  type ThemePreference,
} from "@/lib/theme";

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsDark(document.documentElement.classList.contains("dark"));
    const onChange = () => {
      setIsDark(document.documentElement.classList.contains("dark"));
    };
    window.addEventListener("general-agent-theme-change", onChange);
    return () =>
      window.removeEventListener("general-agent-theme-change", onChange);
  }, []);

  function toggle() {
    const nextDark = !document.documentElement.classList.contains("dark");
    const pref: ThemePreference = nextDark ? "dark" : "light";
    setStoredTheme(pref);
    applyDarkClass(nextDark);
    setIsDark(nextDark);
    window.dispatchEvent(new Event("general-agent-theme-change"));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="theme-toggle"
      aria-label={
        mounted && isDark ? "Hellmodus aktivieren" : "Dunkelmodus aktivieren"
      }
      aria-pressed={mounted ? isDark : undefined}
    >
      {mounted && isDark ? (
        <SunIcon />
      ) : (
        <MoonIcon />
      )}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2v2.5M12 19.5V22M4.5 12H2M22 12h-2.5M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 14.5A8.5 8.5 0 0 1 9.5 4 7 7 0 1 0 20 14.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
