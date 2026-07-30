"use client";

import { useEffect } from "react";
import { PageError } from "@/components/ui/states";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[route-error]", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div>
      <PageError digest={error.digest} />
      <div className="mx-auto max-w-md px-6 pb-8 text-center">
        <button type="button" className="btn btn-secondary" onClick={reset}>
          Erneut versuchen
        </button>
      </div>
    </div>
  );
}
