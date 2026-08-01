"use client";

import { useState } from "react";

export function CopyButton({
  label,
  value,
  disabled,
}: {
  label: string;
  value: string;
  disabled?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary text-xs"
      disabled={disabled || !value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Kopiert" : label}
    </button>
  );
}
