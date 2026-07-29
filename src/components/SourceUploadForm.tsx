"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  createSourceWithUpload,
  type CreateSourceState,
} from "@/actions/sources";
import {
  ALLOWED_SOURCE_EXTENSIONS,
  formatUploadLimit,
} from "@/lib/sourceUpload";

const initialState: CreateSourceState = {
  error: null,
  ok: false,
  sourceId: null,
};

export function SourceUploadForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [state, formAction, pending] = useActionState(
    createSourceWithUpload,
    initialState,
  );

  useEffect(() => {
    if (!state.ok) return;
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }, [state.ok, state.sourceId, router]);

  const accept = ALLOWED_SOURCE_EXTENSIONS.join(",");

  return (
    <form action={formAction} className="mt-4 space-y-3">
      <input type="hidden" name="projectId" value={projectId} />
      {state.error ? (
        <p
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
        >
          {state.error}
        </p>
      ) : null}
      {state.ok && !state.error && !pending ? (
        <p
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          role="status"
        >
          Datei hochgeladen und verarbeitet. Quelle, Job und Knowledge Units sind
          angelegt.
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="file">
            Datei hochladen
          </label>
          <input
            ref={fileRef}
            className="input"
            id="file"
            name="file"
            type="file"
            accept={accept}
            required
            disabled={pending}
          />
          <p className="muted mt-1 text-xs">
            Erlaubt: {ALLOWED_SOURCE_EXTENSIONS.join(", ")} · max.{" "}
            {formatUploadLimit()}
          </p>
        </div>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Wird hochgeladen…" : "Hochladen"}
        </button>
      </div>
    </form>
  );
}
