"use client";

import { useEffect } from "react";
import { PageError } from "@/components/ui/states";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app-error]", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="de">
      <body>
        <PageError digest={error.digest} />
        <div className="mx-auto max-w-md px-6 pb-8 text-center">
          <button type="button" className="btn btn-secondary" onClick={reset}>
            Erneut versuchen
          </button>
        </div>
      </body>
    </html>
  );
}
