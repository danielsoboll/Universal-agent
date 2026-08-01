import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  canAccessAdmin,
  requireAdminAccess,
} from "@/lib/onboarding/access";
import {
  createCustomerAction,
  generateWorkflowAction,
  saveAdapterConfigurationAction,
  saveSetupAdaptersAction,
  saveSetupGoalsAction,
  updateCustomerProductModuleAction,
  uploadCustomerLogoAction,
} from "@/actions/onboarding";
import { MODULE_LABELS } from "@/lib/onboarding/appProfileTypes";
import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { SetupStepNav } from "@/components/onboarding/SetupStepNav";
import { FormSubmitButton } from "@/components/ui/FormSubmitButton";
import { GuideInfoButton } from "@/components/ui/GuideInfoButton";
import { SectionTitleWithInfo } from "@/components/ui/SectionTitleWithInfo";
import { EmptyState, InlineError } from "@/components/ui/states";

const GUIDE_BY_STEP: Record<number, string> = {
  1: "admin.setup.step1_create",
  2: "admin.setup.step2_goals",
  3: "admin.setup.step3_adapters",
  4: "admin.setup.step4_config",
  5: "admin.setup.step5_generate",
};

export default async function AdminSetupPage({
  searchParams,
}: {
  searchParams: Promise<{
    customer?: string;
    step?: string;
    error?: string;
    logo?: string;
  }>;
}) {
  const ctx = await requireAdminAccess();
  const sp = await searchParams;
  const customerId = sp.customer?.trim() || undefined;
  const step = Math.min(
    5,
    Math.max(1, Number(sp.step ?? (customerId ? "2" : "1")) || 1),
  );

  if (customerId && !canAccessAdmin(ctx, customerId)) {
    return (
      <div className="space-y-4">
        <h1 className="admin-page-title">
          Setup-Assistent
        </h1>
        <EmptyState
          title="Kein Zugriff"
          message="Sie haben keinen Admin-Zugriff auf dieses Projekt"
          actionHref="/admin/dashboard"
          actionLabel="Zum Dashboard"
        />
      </div>
    );
  }

  const supabase = await createClient();
  const guideKey = GUIDE_BY_STEP[step]!;
  const guides = await loadUiGuideTexts([guideKey]);

  const customersPromise = supabase
    .from("customers")
    .select("id, name, slug, status, landscape_label, brand_subtitle, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);

  const customerPromise = customerId
    ? supabase.from("customers").select("*").eq("id", customerId).maybeSingle()
    : Promise.resolve({ data: null, error: null });

  const [{ data: customers, error: customersErr }, { data: customer, error: customerError }] =
    await Promise.all([customersPromise, customerPromise]);

  if (customersErr) console.error("[admin/setup] customers", customersErr.message);
  if (customerError) console.error("[admin/setup] customer", customerError.message);

  if (customerId && !customer) {
    return (
      <div className="space-y-4">
        <h1 className="admin-page-title">
          Setup-Assistent
        </h1>
        <EmptyState
          title="Projekt nicht gefunden"
          message="Das gewählte Projekt ist nicht verfügbar"
          actionHref="/admin/setup?step=1"
          actionLabel="Projekt wählen"
        />
      </div>
    );
  }

  // Step-spezifische Daten — nicht alles auf einmal laden.
  let goalTemplates: Array<Record<string, unknown>> | null = null;
  let adapters: Array<Record<string, unknown>> | null = null;
  let selectedGoals: Array<{ goal_type: string }> | null = null;
  let selectedAdapters: Array<{
    id: string;
    input_adapter_id: string;
    configuration: unknown;
    input_adapters: unknown;
  }> | null = null;

  if (step === 2 && customer) {
    const [tpl, goals] = await Promise.all([
      supabase
        .from("goal_templates")
        .select("*")
        .eq("enabled", true)
        .order("sort_order"),
      supabase
        .from("project_goals")
        .select("goal_type")
        .eq("customer_id", customer.id)
        .eq("selected", true),
    ]);
    if (tpl.error) console.error("[admin/setup] goals", tpl.error.message);
    goalTemplates = (tpl.data as Array<Record<string, unknown>>) ?? [];
    selectedGoals = goals.data ?? [];
  }

  if ((step === 3 || step === 4) && customer) {
    const [adp, sel] = await Promise.all([
      supabase
        .from("input_adapters")
        .select("*")
        .eq("enabled", true)
        .order("sort_order"),
      supabase
        .from("customer_input_adapters")
        .select("id, input_adapter_id, configuration, input_adapters(*)")
        .eq("customer_id", customer.id),
    ]);
    if (adp.error) console.error("[admin/setup] adapters", adp.error.message);
    if (sel.error) {
      console.error("[admin/setup] selected adapters", sel.error.message);
    }
    adapters = (adp.data as Array<Record<string, unknown>>) ?? [];
    selectedAdapters = (sel.data as typeof selectedAdapters) ?? [];
  }

  const selectedGoalTypes = new Set(
    (selectedGoals ?? []).map((g) => g.goal_type),
  );
  const selectedAdapterIds = new Set(
    (selectedAdapters ?? []).map((a) => a.input_adapter_id),
  );

  const visibleCustomers = (customers ?? []).filter((c) =>
    canAccessAdmin(ctx, c.id),
  );

  return (
    <div className="space-y-3 sm:space-y-4">
      <div>
        <h1 className="admin-page-title">
          {customer ? "Projekt-Setup" : "Projekt anlegen"}
        </h1>
      </div>

      <SetupStepNav step={step} customerId={customer?.id} />

      {customer && step > 1 ? (
        <div
          className="panel compact px-3 py-2.5 sm:px-4"
          style={{ background: "var(--accent-soft)" }}
        >
          <p className="truncate text-sm font-semibold">
            {customer.name}
            <span className="muted font-normal">
              {customer.brand_subtitle
                ? ` · ${customer.brand_subtitle}`
                : ""}
              {customer.landscape_label
                ? ` · ${customer.landscape_label}`
                : ""}
            </span>
          </p>
        </div>
      ) : null}

      {sp.error ? (
        <InlineError title="Speichern fehlgeschlagen" message={sp.error} />
      ) : null}
      {sp.logo ? (
        <div
          className="panel compact p-3 text-sm"
          style={{ background: "var(--accent-soft)" }}
        >
          Projekt-Branding wurde gespeichert. Projekt-Admin und Projekt-Benutzer
          sehen das Bild in der Kopfzeile.
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-4">
          {customer ? (
            <section className="panel compact admin-card space-y-2 p-3 sm:p-4">
              <SectionTitleWithInfo
                title="Klassifizierung"
                infoTitle="Produkt-Klassifizierung"
                infoBody="Die Klassifizierung (z. B. SAP) steuert Branding und spätere Daten-Zugehörigkeit für alle Anwender dieses Projekts."
              />
              <form
                action={updateCustomerProductModuleAction}
                className="space-y-3"
              >
                <input type="hidden" name="customer_id" value={customer.id} />
                <fieldset>
                  <legend className="sr-only">Produkt-Klassifizierung</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      Object.keys(MODULE_LABELS) as Array<
                        keyof typeof MODULE_LABELS
                      >
                    ).map((key) => (
                      <label
                        key={key}
                        className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-sm"
                      >
                        <input
                          type="radio"
                          name="product_module"
                          value={key}
                          defaultChecked={
                            String(customer.product_module ?? "general") === key
                          }
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium">
                            {MODULE_LABELS[key]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="flex flex-wrap gap-2">
                  <FormSubmitButton pendingLabel="Speichern …">
                    Speichern
                  </FormSubmitButton>
                  <Link
                    href={`/admin/setup?customer=${customer.id}&step=2`}
                    className="btn btn-primary"
                  >
                    Weiter zu Zielen
                  </Link>
                </div>
              </form>

              <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-3">
                <SectionTitleWithInfo
                  title="Projekt-Branding"
                  infoTitle="Branding-Bild"
                  infoBody="Das Bild erscheint für Projekt-Admin und Projekt-Benutzer in der Kopfzeile statt des General-Agent-Logos. Titel: „{Projektname} Agent“."
                />
                {customer.logo_url ? (
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={String(customer.logo_url)}
                      alt=""
                      width={48}
                      height={48}
                      className="h-12 w-12 rounded-[22%] object-cover shadow-sm"
                    />
                    <p className="text-sm text-[var(--muted)]">Aktuelles Logo</p>
                  </div>
                ) : (
                  <p className="text-sm text-[var(--muted)]">
                    Noch kein Branding-Bild hinterlegt.
                  </p>
                )}
                <form
                  action={uploadCustomerLogoAction}
                  className="space-y-3"
                  encType="multipart/form-data"
                >
                  <input type="hidden" name="customer_id" value={customer.id} />
                  <div>
                    <label className="label" htmlFor="logo">
                      Bild hochladen (max. 2&nbsp;MB)
                    </label>
                    <input
                      className="input"
                      id="logo"
                      name="logo"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      required
                    />
                  </div>
                  <FormSubmitButton pendingLabel="Wird hochgeladen …">
                    Branding speichern
                  </FormSubmitButton>
                </form>
              </div>
            </section>
          ) : (
            <>
              <section className="panel compact admin-card space-y-2 p-3 sm:p-4">
                <h2 className="text-base font-semibold">Projekt wählen</h2>
                {visibleCustomers.length ? (
                  <ul className="divide-y divide-[var(--border)]">
                    {visibleCustomers.map((c) => (
                      <li key={c.id}>
                        <Link
                          href={`/admin/setup?customer=${c.id}&step=2`}
                          prefetch
                          className="flex items-center justify-between gap-3 py-2.5 text-sm"
                        >
                          <span className="min-w-0 truncate">
                            {c.name}
                            <span className="muted font-normal">
                              {c.brand_subtitle
                                ? ` · ${c.brand_subtitle}`
                                : ""}
                              {c.landscape_label
                                ? ` · ${c.landscape_label}`
                                : ""}
                            </span>
                          </span>
                          <span className="badge shrink-0 text-[0.65rem]">
                            {c.status}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted text-sm">Noch keine Projekte vorhanden.</p>
                )}
              </section>

              {ctx.isPlatformAdmin ? (
                <form
                  action={createCustomerAction}
                  className="panel compact admin-card space-y-2 p-3 sm:p-4"
                >
                  <SectionTitleWithInfo
                    title="Neues Projekt"
                    guide={guides.get(guideKey)}
                    infoTitle="Projekt anlegen"
                  />
                  <div>
                    <label className="label" htmlFor="name">
                      Projektname
                    </label>
                    <input
                      className="input"
                      id="name"
                      name="name"
                      required
                      placeholder="z. B. SAP Analyse P01"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="client_name">
                      Kunde
                    </label>
                    <p className="muted mb-1 text-xs">
                      Firmen- oder Mandantenname (Anzeige im Dashboard).
                    </p>
                    <input
                      className="input"
                      id="client_name"
                      name="client_name"
                      placeholder="z. B. Muster AG"
                    />
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
                    <input
                      className="input"
                      id="landscape_label"
                      name="landscape_label"
                      placeholder="z. B. P01"
                    />
                  </div>
                  <fieldset>
                    <legend className="label">Produkt-Klassifizierung</legend>
                    <p className="muted mb-2 text-xs">
                      Steuert Branding für alle Projekt-User (z.&nbsp;B. SAP
                      Z-Agent).
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(
                        Object.keys(MODULE_LABELS) as Array<
                          keyof typeof MODULE_LABELS
                        >
                      ).map((key) => (
                        <label
                          key={key}
                          className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-sm"
                        >
                          <input
                            type="radio"
                            name="product_module"
                            value={key}
                            defaultChecked={key === "general"}
                            className="mt-0.5"
                            required
                          />
                          <span>
                            <span className="font-medium">
                              {MODULE_LABELS[key]}
                            </span>
                            {key === "sap" ? (
                              <span className="muted block text-xs">
                                SAP Z-Agent Oberfläche
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <FormSubmitButton pendingLabel="Wird angelegt …">
                    Anlegen und weiter
                  </FormSubmitButton>
                </form>
              ) : (
                <EmptyState
                  title="Kein Anlege-Recht"
                  message="Wählen Sie ein bestehendes Projekt oder bitten Sie einen Platform Admin um Anlage"
                  actionHref="/admin/dashboard"
                  actionLabel="Zum Dashboard"
                />
              )}
            </>
          )}
        </div>
      ) : null}

      {customer && step === 2 ? (
        <form action={saveSetupGoalsAction} className="space-y-4">
          <input type="hidden" name="customer_id" value={customer.id} />
          <SectionTitleWithInfo
            title="Zielsetzung"
            infoTitle="Zielsetzung wählen"
            infoBody="Wählen Sie eine oder mehrere Zielsetzungen. Über den Info-Button neben jedem Ziel sehen Sie Bedeutung, erwartete Ergebnisse und typische Quellen."
          />
          <div className="grid gap-3 md:grid-cols-2">
            {(goalTemplates ?? []).map((g) => (
              <div
                key={String(g.id)}
                className="panel compact flex items-start gap-2 p-3 sm:p-4"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    name="goal_type"
                    value={String(g.goal_type)}
                    defaultChecked={selectedGoalTypes.has(String(g.goal_type))}
                    className="mt-1"
                  />
                  <div className="min-w-0">
                    <p className="font-semibold">{String(g.title)}</p>
                  </div>
                </label>
                <GuideInfoButton
                  title={String(g.title)}
                  body={String(g.description ?? "")}
                  sections={[
                    {
                      heading: "Bedeutung",
                      text: String(g.meaning_text ?? ""),
                    },
                    {
                      heading: "Ergebnisse",
                      text: String(g.outcomes_text ?? ""),
                    },
                    {
                      heading: "Typische Quellen",
                      text: String(g.typical_sources_text ?? ""),
                    },
                  ]}
                />
              </div>
            ))}
          </div>
          {!goalTemplates?.length ? (
            <EmptyState
              title="Keine Zielvorlagen"
              message="Zielvorlagen fehlen in der Datenbank. Bitte Seed/Migration prüfen"
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/admin/setup?customer=${customer.id}&step=1`}
              className="btn btn-secondary"
            >
              Zurück
            </Link>
            <FormSubmitButton pendingLabel="Speichern …">
              Speichern und weiter
            </FormSubmitButton>
          </div>
        </form>
      ) : null}

      {customer && step === 3 ? (
        <form action={saveSetupAdaptersAction} className="space-y-4">
          <input type="hidden" name="customer_id" value={customer.id} />
          <SectionTitleWithInfo
            title="Input-Adapter"
            guide={guides.get(guideKey)}
            infoTitle="Adapter wählen"
          />
          <div className="grid gap-3 md:grid-cols-2">
            {(adapters ?? []).map((a) => {
              const status = String(a.availability_status ?? "");
              return (
                <div
                  key={String(a.id)}
                  className="panel compact flex items-start gap-2 p-3 sm:p-4"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      name="adapter_id"
                      value={String(a.id)}
                      defaultChecked={selectedAdapterIds.has(String(a.id))}
                      disabled={status === "disabled"}
                      className="mt-1"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{String(a.name)}</p>
                        <span className="badge">
                          {status === "available"
                            ? "verfügbar"
                            : status === "planned"
                              ? "geplant"
                              : "deaktiviert"}
                        </span>
                      </div>
                      <p className="muted mt-1 text-sm">
                        {String(a.description ?? "")}
                      </p>
                    </div>
                  </label>
                  <GuideInfoButton
                    title={String(a.name)}
                    body={String(a.description ?? "")}
                    sections={[
                      {
                        heading: "Benötigte Daten",
                        text: String(a.data_needed_text ?? ""),
                      },
                      {
                        heading: "Erkennung / Ergebnis",
                        text: String(a.detection_text ?? ""),
                      },
                      {
                        heading: "Exportform",
                        text: String(a.export_form_text ?? ""),
                      },
                      {
                        heading: "Datenschutz",
                        text: String(a.privacy_text ?? ""),
                      },
                    ]}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/admin/setup?customer=${customer.id}&step=2`}
              className="btn btn-secondary"
            >
              Zurück
            </Link>
            <FormSubmitButton pendingLabel="Speichern …">
              Speichern und weiter
            </FormSubmitButton>
          </div>
        </form>
      ) : null}

      {customer && step === 4 ? (
        <form action={saveAdapterConfigurationAction} className="space-y-4">
          <input type="hidden" name="customer_id" value={customer.id} />
          <SectionTitleWithInfo
            title="Konfiguration"
            guide={guides.get(guideKey)}
            infoTitle="Adapter konfigurieren"
          />
          {(selectedAdapters ?? []).map((row) => {
            const raw = row.input_adapters as unknown;
            const ia = (Array.isArray(raw) ? raw[0] : raw) as {
              name: string;
              configuration_schema: {
                properties?: Record<
                  string,
                  {
                    title?: string;
                    type?: string;
                    enum?: string[];
                    default?: unknown;
                  }
                >;
              };
            } | null;
            if (!ia) return null;
            const props = ia.configuration_schema?.properties ?? {};
            const conf = (row.configuration ?? {}) as Record<string, unknown>;
            return (
              <fieldset key={row.id} className="panel compact admin-card space-y-2 p-3 sm:p-4">
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
              message={
                sp.error
                  ? sp.error
                  : "Bitte im vorherigen Schritt Adapter anhaken und unten auf „Weiter“ klicken (nicht in der Schritt-Leiste vorspringen)"
              }
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
            <FormSubmitButton pendingLabel="Speichern …">
              Speichern und weiter
            </FormSubmitButton>
          </div>
        </form>
      ) : null}

      {customer && step === 5 ? (
        <form
          action={generateWorkflowAction}
          className="panel compact admin-card space-y-2.5 p-3 sm:p-4"
        >
          <input type="hidden" name="customer_id" value={customer.id} />
          <SectionTitleWithInfo
            title="Datenimport starten"
            guide={guides.get(guideKey)}
            infoTitle="Datenimport starten"
          />
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/admin/setup?customer=${customer.id}&step=4`}
              className="btn btn-secondary"
            >
              Zurück
            </Link>
            <FormSubmitButton pendingLabel="Wird vorbereitet …">
              Zum Datenimport
            </FormSubmitButton>
          </div>
        </form>
      ) : null}

      {step > 1 && !customer ? (
        <EmptyState
          title="Kein Projekt gewählt"
          message="Bitte zuerst ein Projekt anlegen oder auswählen"
          actionHref="/admin/setup?step=1"
          actionLabel="Zu Schritt 1"
        />
      ) : null}
    </div>
  );
}
