import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireAdminAccess } from "@/lib/onboarding/access";
import {
  createCustomerAction,
  generateWorkflowAction,
  saveAdapterConfigurationAction,
  saveSetupAdaptersAction,
  saveSetupGoalsAction,
} from "@/actions/onboarding";

export default async function AdminSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; step?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const customerId = sp.customer;
  const step = Number(sp.step ?? (customerId ? "2" : "1"));
  const supabase = await createClient();

  const { data: customer } = customerId
    ? await supabase
        .from("customers")
        .select("*")
        .eq("id", customerId)
        .maybeSingle()
    : { data: null };

  if (customerId && customer) {
    await requireAdminAccess(customerId);
  }

  const [{ data: goalTemplates }, { data: adapters }, { data: selectedGoals }, { data: selectedAdapters }] =
    await Promise.all([
      supabase.from("goal_templates").select("*").eq("enabled", true).order("sort_order"),
      supabase.from("input_adapters").select("*").eq("enabled", true).order("sort_order"),
      customerId
        ? supabase
            .from("project_goals")
            .select("goal_type")
            .eq("customer_id", customerId)
            .eq("selected", true)
        : Promise.resolve({ data: [] as { goal_type: string }[] }),
      customerId
        ? supabase
            .from("customer_input_adapters")
            .select("id, input_adapter_id, configuration, input_adapters(*)")
            .eq("customer_id", customerId)
        : Promise.resolve({ data: [] as never[] }),
    ]);

  const selectedGoalTypes = new Set((selectedGoals ?? []).map((g) => g.goal_type));
  const selectedAdapterIds = new Set(
    (selectedAdapters ?? []).map((a) => a.input_adapter_id as string),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Setup-Assistent</h1>
        <p className="muted mt-1">
          Fünf Schritte: Kunde → Ziele → Adapter → Konfiguration → Fahrplan.
        </p>
      </div>

      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Setup-Schritte">
        {[1, 2, 3, 4, 5].map((n) => (
          <li
            key={n}
            className={`rounded-lg px-3 py-1.5 ${
              step === n ? "bg-[var(--accent)] text-white" : "bg-[#eef2f6]"
            }`}
          >
            Schritt {n}
          </li>
        ))}
      </ol>

      {step === 1 && ctx.isPlatformAdmin ? (
        <form action={createCustomerAction} className="panel space-y-4 p-6">
          <h2 className="text-lg font-semibold">1. Kunde / Projekt</h2>
          <div>
            <label className="label" htmlFor="name">
              Projektname
            </label>
            <input className="input" id="name" name="name" required />
          </div>
          <div>
            <label className="label" htmlFor="slug">
              Slug (optional)
            </label>
            <input className="input" id="slug" name="slug" placeholder="mein-kunde" />
          </div>
          <div>
            <label className="label" htmlFor="description">
              Kurzbeschreibung
            </label>
            <textarea className="textarea" id="description" name="description" rows={3} />
          </div>
          <div>
            <label className="label" htmlFor="landscape_label">
              System- / Landschaftsbezeichnung (optional)
            </label>
            <input className="input" id="landscape_label" name="landscape_label" />
          </div>
          <button type="submit" className="btn btn-primary">
            Anlegen und weiter
          </button>
        </form>
      ) : null}

      {step === 1 && !ctx.isPlatformAdmin ? (
        <div className="panel p-6">
          <p>Wählen Sie ein bestehendes Projekt oder bitten Sie einen Platform Admin um Anlage.</p>
          <Link href="/admin/dashboard" className="btn btn-secondary mt-4 inline-flex">
            Zum Dashboard
          </Link>
        </div>
      ) : null}

      {customer && step === 2 ? (
        <form action={saveSetupGoalsAction} className="space-y-4">
          <input type="hidden" name="customer_id" value={customer.id} />
          <h2 className="text-lg font-semibold">2. Zielsetzung</h2>
          <p className="muted text-sm">Mehrfachauswahl — Inhalte kommen aus Vorlagen.</p>
          <div className="grid gap-4 md:grid-cols-2">
            {(goalTemplates ?? []).map((g) => (
              <label key={g.id} className="panel block cursor-pointer p-4">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    name="goal_type"
                    value={g.goal_type}
                    defaultChecked={selectedGoalTypes.has(g.goal_type)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-semibold">{g.title}</p>
                    <p className="mt-1 text-sm muted">{g.description}</p>
                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer font-medium">Details</summary>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>
                          <strong>Bedeutung:</strong> {g.meaning_text}
                        </li>
                        <li>
                          <strong>Ergebnisse:</strong> {g.outcomes_text}
                        </li>
                        <li>
                          <strong>Typische Quellen:</strong> {g.typical_sources_text}
                        </li>
                      </ul>
                    </details>
                  </div>
                </div>
              </label>
            ))}
          </div>
          <button type="submit" className="btn btn-primary">
            Weiter zu Adaptern
          </button>
        </form>
      ) : null}

      {customer && step === 3 ? (
        <form action={saveSetupAdaptersAction} className="space-y-4">
          <input type="hidden" name="customer_id" value={customer.id} />
          <h2 className="text-lg font-semibold">3. Input-Adapter</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {(adapters ?? []).map((a) => (
              <label key={a.id} className="panel block cursor-pointer p-4">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    name="adapter_id"
                    value={a.id}
                    defaultChecked={selectedAdapterIds.has(a.id)}
                    disabled={a.availability_status === "disabled"}
                    className="mt-1"
                  />
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{a.name}</p>
                      <span className="badge">
                        {a.availability_status === "available"
                          ? "verfügbar"
                          : a.availability_status === "planned"
                            ? "geplant"
                            : "deaktiviert"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm muted">{a.description}</p>
                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer font-medium">Infos</summary>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>Daten: {a.data_needed_text}</li>
                        <li>Erkennung: {a.detection_text}</li>
                        <li>Exportform: {a.export_form_text}</li>
                        <li>Datenschutz: {a.privacy_text}</li>
                      </ul>
                    </details>
                  </div>
                </div>
              </label>
            ))}
          </div>
          <button type="submit" className="btn btn-primary">
            Weiter zur Konfiguration
          </button>
        </form>
      ) : null}

      {customer && step === 4 ? (
        <form action={saveAdapterConfigurationAction} className="space-y-6">
          <input type="hidden" name="customer_id" value={customer.id} />
          <h2 className="text-lg font-semibold">4. Konfiguration</h2>
          <p className="muted text-sm">
            Felder werden aus dem configuration_schema der Adapter gerendert.
          </p>
          {(selectedAdapters ?? []).map((row) => {
            const raw = row.input_adapters as unknown;
            const ia = (Array.isArray(raw) ? raw[0] : raw) as {
              name: string;
              configuration_schema: {
                properties?: Record<
                  string,
                  { title?: string; type?: string; enum?: string[]; default?: unknown }
                >;
                required?: string[];
              };
            } | null;
            if (!ia) return null;
            const props = ia.configuration_schema?.properties ?? {};
            const conf = (row.configuration ?? {}) as Record<string, unknown>;
            return (
              <fieldset key={row.id} className="panel space-y-3 p-5">
                <legend className="px-1 font-semibold">{ia.name}</legend>
                {Object.keys(props).length === 0 ? (
                  <p className="text-sm muted">Keine zusätzlichen Felder.</p>
                ) : (
                  Object.entries(props).map(([key, schema]) => {
                    const name = `cfg__${row.id}__${key}`;
                    const label = schema.title ?? key;
                    if (schema.enum) {
                      return (
                        <div key={key}>
                          <label className="label" htmlFor={name}>
                            {label}
                          </label>
                          <select
                            className="input"
                            id={name}
                            name={name}
                            defaultValue={String(conf[key] ?? "")}
                          >
                            <option value="">—</option>
                            {schema.enum.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    }
                    if (schema.type === "boolean") {
                      return (
                        <div key={key}>
                          <label className="label" htmlFor={name}>
                            {label}
                          </label>
                          <select
                            className="input"
                            id={name}
                            name={name}
                            defaultValue={
                              conf[key] === true
                                ? "true"
                                : conf[key] === false
                                  ? "false"
                                  : String(schema.default ?? "")
                            }
                          >
                            <option value="">—</option>
                            <option value="true">Ja</option>
                            <option value="false">Nein</option>
                          </select>
                        </div>
                      );
                    }
                    return (
                      <div key={key}>
                        <label className="label" htmlFor={name}>
                          {label}
                        </label>
                        <input
                          className="input"
                          id={name}
                          name={name}
                          type={schema.type === "integer" ? "number" : "text"}
                          defaultValue={
                            conf[key] != null
                              ? String(conf[key])
                              : schema.default != null
                                ? String(schema.default)
                                : ""
                          }
                        />
                      </div>
                    );
                  })
                )}
              </fieldset>
            );
          })}
          <button type="submit" className="btn btn-primary">
            Weiter zur Fahrplan-Erzeugung
          </button>
        </form>
      ) : null}

      {customer && step === 5 ? (
        <form action={generateWorkflowAction} className="panel space-y-4 p-6">
          <input type="hidden" name="customer_id" value={customer.id} />
          <h2 className="text-lg font-semibold">5. Fahrplan erzeugen</h2>
          <p className="text-sm">
            Aus Zielsetzung und Adaptern wird deterministisch ein versionierter
            Kundenfahrplan erzeugt. Bestehende aktive Fahrpläne werden archiviert
            (Idempotenz / Neu-Generierung).
          </p>
          <p className="text-sm muted">
            OpenAI ist für die Erzeugung nicht erforderlich. Pipeline-Schritte
            werden nur verknüpft, nicht gestartet.
          </p>
          <button type="submit" className="btn btn-primary">
            Fahrplan jetzt erzeugen
          </button>
        </form>
      ) : null}
    </div>
  );
}
