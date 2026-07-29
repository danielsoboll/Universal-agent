"use client";

import { useActionState } from "react";
import {
  testOpenAIConnection,
  type AiHealthActionState,
} from "@/actions/aiHealth";

const initialState: AiHealthActionState = { error: null, report: null };

export function ProviderHealthPanel() {
  const [state, formAction, pending] = useActionState(
    testOpenAIConnection,
    initialState,
  );

  return (
    <section className="panel mt-8 p-6">
      <h2 className="text-lg font-semibold">OpenAI-Verbindung</h2>
      <p className="muted mt-1 text-sm">
        Technischer Health-Check (nur Owner). Keine Fachdaten, kein Chat.
      </p>

      <form action={formAction} className="mt-4">
        <button className="btn btn-secondary" type="submit" disabled={pending}>
          {pending ? "Test läuft…" : "Verbindung testen"}
        </button>
      </form>

      {state.error ? (
        <p
          className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
        >
          {state.error}
        </p>
      ) : null}

      {state.report ? (
        <dl className="mt-3 grid gap-1 text-sm">
          <div>
            <dt className="muted inline">erreichbar: </dt>
            <dd className="inline font-medium">{state.report.erreichbar}</dd>
          </div>
          <div>
            <dt className="muted inline">Modell: </dt>
            <dd className="inline">{state.report.modell}</dd>
          </div>
          <div>
            <dt className="muted inline">Laufzeit: </dt>
            <dd className="inline">{state.report.laufzeit_ms} ms</dd>
          </div>
          <div>
            <dt className="muted inline">Fehlerkategorie: </dt>
            <dd className="inline">
              {state.report.fehlerkategorie ?? "—"}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
