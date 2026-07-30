"use client";

import { useEffect } from "react";
import { PageError } from "@/components/ui/states";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin-error]", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div>
      <PageError
        title="Admin-Bereich konnte nicht geladen werden"
        message="Prüfen Sie Ihre Anmeldung und versuchen Sie es erneut."
        digest={error.digest}
      />
      <div className="mx-auto max-w-md px-6 pb-8 text-center">
        <button type="button" className="btn btn-secondary" onClick={reset}>
          Erneut versuchen
        </button>
      </div>
    </div>
  );
}
