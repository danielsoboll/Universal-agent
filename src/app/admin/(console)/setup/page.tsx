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
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { ActionWithGuide } from "@/components/onboarding/ActionGuide";
import { SetupStepNav } from "@/components/onboarding/SetupStepNav";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import { EmptyState, InlineError } from "@/components/ui/states";

export default async function AdminSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; step?: string; error?: string }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const customerId = sp.customer;
  const step = Number(sp.step ?? (customerId ? "2" : "1"));
  const guides = await loadUiGuideTexts([
    "admin.setup.step1_create",
    "admin.setup.step2_goals",
    "admin.setup.step3_adapters",
    "admin.setup.step4_config",
    "admin.setup.step5_generate",
  ]);
  const supabase = await createClient();

  const { data: customer, error: customerError } = customerId
    ? await supabase.from("customers").select("*").eq("id", customerId).maybeSingle()
    : { data: null, error: null };

  if (customerError) {
    console.error("[admin/setup] customer", customerError.message);
  }

  if (customerId && customer) {
    await requireAdminAccess(customerId);
  }

  if (customerId && !customer) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Setup-Assistent
        </h1>
        <EmptyState
          title="Kunde nicht gefunden"
          message="Der gewählte Kunde ist nicht verfügbar oder Sie haben keinen Zugriff."
          actionHref="/admin/dashboard"
          actionLabel="Zum Dashboard"
        />
      </div>
    );
  }

  const [
    { data: goalTemplates, error: goalsTplErr },
    { data: adapters, error: adaptersErr },
    { data: selectedGoals },
    { data: selectedAdapters },
  ] = await Promise.all([
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

  if (goalsTplErr) console.error("[admin/setup] goals", goalsTplErr.message);
  if (adaptersErr) console.error("[admin/setup] adapters", adaptersErr.message);

  const selectedGoalTypes = new Set((selectedGoals ?? []).map((g) => g.goal_type));
  const selectedAdapterIds = new Set(
    (selectedAdapters ?? []).map((a) => a.input_adapter_id as string),
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Setup-Assistent
        </h1>
        <p className="muted mt-1 text-sm">
          Kunde → Ziele → Adapter → Konfiguration → Fahrplan
        </p>
      </div>

      <SetupStepNav step={step} customerId={customer?.id} />

      {sp.error ? (
        <InlineError title="Speichern fehlgeschlagen" message={sp.error} />
      ) : null}

      {step === 1 && ctx.isPlatformAdmin ? (
        <form action={createCustomerAction} className="panel compact space-y-3 p-4 sm:p-5">
          <h2 className="text-base font-semibold">Kunde / Projekt anlegen</h2>
          <div>
            <label className="label" htmlFor="name">
              Projektname
            </label>
            <p className="muted mb-1 text-xs">Anzeigename für Dashboard und Fahrplan.</p>
            <input
              className="input"
              id="name"
              name="name"
              required
              placeholder="z. B. Muster AG SAP"
              defaultValue={typeof sp.error === "string" ? "" : undefined}
            />
          </div>
          <div>
            <label className="label" htmlFor="slug">
              Slug
            </label>
            <p className="muted mb-1 text-xs">Optional — wird sonst aus dem Namen erzeugt.</p>
            <input className="input" id="slug" name="slug" placeholder="muster-ag" />
          </div>
          <div>
            <label className="label" htmlFor="description">
              Kurzbeschreibung
            </label>
            <textarea
              className="textarea"
              id="description"
              name="description"
              rows={2}
              placeholder="Kurz, wofür dieses Projekt steht"
            />
          </div>
          <div>
            <label className="label" htmlFor="landscape_label">
              System / Landschaft
            </label>
            <p className="muted mb-1 text-xs">Optional.</p>
            <input
              className="input"
              id="landscape_label"
              name="landscape_label"
              placeholder="z. B. P01"
            />
          </div>
          <ActionWithGuide guide={guides.get("admin.setup.step1_create")}>
            <FormSubmitButton pendingLabel="Wird angelegt …">
              Anlegen und weiter
            </FormSubmitButton>
          </ActionWithGuide>
        </form>
      ) : null}

      {step === 1 && !ctx.isPlatformAdmin ? (
        <EmptyState
          title="Kein Anlege-Recht"
          message="Wählen Sie ein bestehendes Projekt oder bitten Sie einen Platform Admin um Anlage."
          actionHref="/admin/dashboard"
          actionLabel="Zum Dashboard"
        />
      ) : null}

      {customer && step === 2 ? (
        <form action={saveSetupGoalsAction} className="space-y-4">
          <input type="hidden" name="customer_id" value={customer.id} />
          <div>
            <h2 className="text-base font-semibold">Zielsetzung</h2>
            <p className="muted mt-1 text-sm">Mehrfachauswahl aus Vorlagen.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {(goalTemplates ?? []).map((g) => (
              <label key={g.id} className="panel compact block cursor-pointer p-3 sm:p-4">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    name="goal_type"
                    value={g.goal_type}
                    defaultChecked={selectedGoalTypes.has(g.goal_type)}
                    className="mt-1"
                  />
                  <div className="min-w-0">
                    <p className="font-semibold">{g.title}</p>
                    <p className="muted mt-1 text-sm">{g.description}</p>
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
          {!goalTemplates?.length ? (
            <EmptyState
              title="Keine Zielvorlagen"
              message="Zielvorlagen fehlen in der Datenbank. Bitte Seed/Migration prüfen."
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/admin/setup?customer=${customer.id}&step=1`}
              className="btn btn-secondary"
            >
              Zurück
            </Link>
            <ActionWithGuide guide={guides.get("admin.setup.step2_goals")}>
              <FormSubmitButton pendingLabel="Speichern …">Weiter</FormSubmitButton>
            </ActionWithGuide>
          </div>
        </form>
      ) : null}

      {customer && step === 3 ? (
        <form action={saveSetupAdaptersAction} className="space-y-4">
          <input type="hidden" name="customer_id" value={customer.id} />
          <div>
            <h2 className="text-base font-semibold">Input-Adapter</h2>
            <p className="muted mt-1 text-sm">Welche Quellen sollen angebunden werden?</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {(adapters ?? []).map((a) => (
              <label key={a.id} className="panel compact block cursor-pointer p-3 sm:p-4">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    name="adapter_id"
                    value={a.id}
                    defaultChecked={selectedAdapterIds.has(a.id)}
                    disabled={a.availability_status === "disabled"}
                    className="mt-1"
                  />
                  <div className="min-w-0">
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
                    <p className="muted mt-1 text-sm">{a.description}</p>
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
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/admin/setup?customer=${customer.id}&step=2`}
              className="btn btn-secondary"
            >
              Zurück
            </Link>
            <ActionWithGuide guide={guides.get("admin.setup.step3_adapters")}>
              <FormSubmitButton pendingLabel="Speichern …">Weiter</FormSubmitButton>
            </ActionWithGuide>
          </div>
        </form>
      ) : null}

      {customer && step === 4 ? (
        <form action={saveAdapterConfigurationAction} className="space-y-4">
          <input type="hidden" name="customer_id" value={customer.id} />
          <div>
            <h2 className="text-base font-semibold">Konfiguration</h2>
            <p className="muted mt-1 text-sm">
              Felder aus dem Schema der gewählten Adapter.
            </p>
          </div>
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
              <fieldset key={row.id} className="panel compact space-y-3 p-4">
                <legend className="px-1 font-semibold">{ia.name}</legend>
                {Object.keys(props).length === 0 ? (
                  <p className="muted text-sm">Keine zusätzlichen Felder.</p>
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
          {!selectedAdapters?.length ? (
            <EmptyState
              title="Keine Adapter gewählt"
              message="Bitte im vorherigen Schritt mindestens einen Adapter auswählen."
              actionHref={`/admin/setup?customer=${customer.id}&step=3`}
              actionLabel="Zurück zu Adaptern"
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/admin/setup?customer=${customer.id}&step=3`}
              className="btn btn-secondary"
            >
              Zurück
            </Link>
            <ActionWithGuide guide={guides.get("admin.setup.step4_config")}>
              <FormSubmitButton pendingLabel="Speichern …">Weiter</FormSubmitButton>
            </ActionWithGuide>
          </div>
        </form>
      ) : null}

      {customer && step === 5 ? (
        <form action={generateWorkflowAction} className="panel compact space-y-4 p-4 sm:p-5">
          <input type="hidden" name="customer_id" value={customer.id} />
          <h2 className="text-base font-semibold">Fahrplan erzeugen</h2>
          <p className="text-sm">
            Aus Zielsetzung und Adaptern wird ein versionierter Kundenfahrplan
            erzeugt. Bestehende aktive Fahrpläne werden archiviert.
          </p>
          <p className="muted text-sm">
            OpenAI ist für die Erzeugung nicht erforderlich. Pipeline-Schritte
            werden nur verknüpft, nicht gestartet.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/admin/setup?customer=${customer.id}&step=4`}
              className="btn btn-secondary"
            >
              Zurück
            </Link>
            <ActionWithGuide guide={guides.get("admin.setup.step5_generate")}>
              <FormSubmitButton pendingLabel="Wird erzeugt …">
                Anlegen und weiter
              </FormSubmitButton>
            </ActionWithGuide>
          </div>
        </form>
      ) : null}
    </div>
  );
}
