"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  canAccessAdmin,
  canAccessApp,
  canAccessProjectConsole,
  requireAdminAccess,
  requireUser,
} from "@/lib/onboarding/access";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateCustomerWorkflow,
  recomputeStepStatuses,
  type WorkflowStepTemplateInput,
  type WorkflowTemplateInput,
  type VisibleWhen,
} from "@/lib/onboarding/generateCustomerWorkflow";
import { getPipelineStep } from "@/lib/core/pipelineRegistry";
import {
  isAppModuleKey,
  moduleFlagsFromProduct,
  type AppModuleKey,
} from "@/lib/onboarding/appProfileTypes";

/** Matches DB constraint customers_slug_format */
const CUSTOMER_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

function slugify(name: string): string {
  let slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (!slug) slug = "kunde";
  // Constraint requires at least 2 chars: [a-z0-9][a-z0-9_-]{1,62}
  if (slug.length < 2) slug = `${slug}x`;
  return slug;
}

function setupErrorRedirect(message: string, customerId?: string, step?: number) {
  const q = new URLSearchParams();
  if (customerId) q.set("customer", customerId);
  if (step) q.set("step", String(step));
  q.set("error", message);
  redirect(`/admin/setup?${q.toString()}`);
}

type PostgrestLikeError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

function formatCustomerInsertError(error: PostgrestLikeError): string {
  const code = error.code ?? "";
  const details = error.details ? ` — ${error.details}` : "";
  const hint = error.hint ? ` Hinweis: ${error.hint}` : "";
  if (code === "42501") {
    return (
      "RLS blockiert customers INSERT (42501): is_platform_admin() ist false für diese Session. " +
      "App-Recht general_admin reicht nicht — Eintrag in platform_admins fehlt oder JWT/Session ungültig." +
      details
    );
  }
  if (code === "23505") {
    return `Slug bereits vergeben (23505)${details}. Bitte anderen Slug wählen.`;
  }
  if (code === "23514") {
    return (
      `Slug verletzt Constraint customers_slug_format (23514): ` +
      `erlaubt ^[a-z0-9][a-z0-9_-]{1,62}$ (mind. 2 Zeichen).${details}`
    );
  }
  if (code === "PGRST116") {
    return (
      "Insert ohne sichtbare Rückgabe (PGRST116): Zeile ggf. geschrieben, aber SELECT-Policy " +
      "liefert sie nicht. platform_admins / Membership prüfen." +
      details
    );
  }
  return `Supabase-Fehler${code ? ` ${code}` : ""}: ${error.message ?? "unbekannt"}${details}${hint}`;
}

export async function createCustomerAction(formData: FormData) {
  const ctx = await requireAdminAccess();
  if (!ctx.isPlatformAdmin) {
    setupErrorRedirect("Nur Platform Admins dürfen Projekte anlegen.");
  }

  const name = String(formData.get("name") ?? "").trim();
  const clientName = String(
    formData.get("client_name") ?? formData.get("brand_subtitle") ?? "",
  ).trim();
  const description = String(formData.get("description") ?? "").trim();
  const landscape = String(formData.get("landscape_label") ?? "").trim();
  const productModuleRaw = String(formData.get("product_module") ?? "general")
    .trim()
    .toLowerCase();
  // Slug bleibt intern (unique key) — optional aus Formular, sonst aus Projektname.
  let slug = String(formData.get("slug") ?? "").trim().toLowerCase() || slugify(name);
  if (!name) setupErrorRedirect("Projektname ist erforderlich.");
  if (!CUSTOMER_SLUG_RE.test(slug)) {
    setupErrorRedirect(
      `Interner Projekt-Schlüssel „${slug}“ ist ungültig. Bitte Projektname anpassen.`,
    );
  }
  if (!isAppModuleKey(productModuleRaw)) {
    setupErrorRedirect("Ungültige Projekt-Klassifizierung.");
  }
  const productModule = productModuleRaw;

  const supabase = await createClient();

  // Sync app-level general_admin with RLS helper (platform_admins row).
  const { data: rpcIsAdmin, error: rpcError } = await supabase.rpc(
    "is_platform_admin",
  );
  if (rpcError) {
    console.error("[onboarding] is_platform_admin rpc", rpcError);
  }
  if (!rpcIsAdmin) {
    try {
      const admin = createAdminClient();
      const { error: upsertAdminErr } = await admin.from("platform_admins").upsert(
        { user_id: ctx.userId, created_by: ctx.userId },
        { onConflict: "user_id" },
      );
      if (upsertAdminErr) {
        setupErrorRedirect(
          `is_platform_admin()=false und Nachzug in platform_admins fehlgeschlagen: ${upsertAdminErr.message}`,
        );
      }
    } catch (e) {
      setupErrorRedirect(
        `is_platform_admin()=false; Service-Role für platform_admins nicht verfügbar: ${
          e instanceof Error ? e.message : "unbekannt"
        }`,
      );
    }
  }

  const payload = {
    name,
    slug,
    description: description || null,
    brand_subtitle: clientName || null,
    landscape_label: landscape || null,
    product_module: productModule,
    status: "onboarding" as const,
    created_by: ctx.userId,
  };

  let { data, error } = await supabase
    .from("customers")
    .insert(payload)
    .select("id")
    .single();

  // Fallback: authenticated insert still RLS-blocked → service role after app authz.
  if (error?.code === "42501" || error?.code === "PGRST116" || (!data && error)) {
    console.error("[onboarding] createCustomer user-client", error);
    try {
      const admin = createAdminClient();
      const retry = await admin
        .from("customers")
        .insert(payload)
        .select("id")
        .single();
      data = retry.data;
      error = retry.error;
      if (!error && data) {
        console.warn(
          "[onboarding] createCustomer: Insert via Service-Role nach RLS/Returning-Problem",
        );
      }
    } catch (e) {
      setupErrorRedirect(
        `${formatCustomerInsertError(error ?? { message: "Insert fehlgeschlagen" })} ` +
          `Service-Role-Fallback: ${e instanceof Error ? e.message : "unbekannt"}`,
      );
    }
  }

  if (error || !data) {
    console.error("[onboarding] createCustomer", error);
    setupErrorRedirect(
      formatCustomerInsertError(
        error ?? { message: "Keine Kundenzeile zurückgegeben." },
      ),
    );
  }

  const membership = {
    customer_id: data!.id,
    user_id: ctx.userId,
    role: "customer_admin" as const,
    status: "active" as const,
  };
  let { error: memErr } = await supabase
    .from("customer_memberships")
    .upsert(membership, { onConflict: "customer_id,user_id" });
  if (memErr) {
    console.error("[onboarding] createCustomer membership", memErr);
    const firstMemErr = memErr;
    try {
      const admin = createAdminClient();
      const retryMem = await admin
        .from("customer_memberships")
        .upsert(membership, { onConflict: "customer_id,user_id" });
      memErr = retryMem.error;
    } catch (e) {
      setupErrorRedirect(
        `Kunde ${data!.id} angelegt, Membership fehlgeschlagen: ${firstMemErr.message}; ` +
          `Fallback: ${e instanceof Error ? e.message : "unbekannt"}`,
      );
    }
  }
  if (memErr) {
    setupErrorRedirect(
      `Kunde ${data!.id} angelegt, Membership fehlgeschlagen (${memErr.code ?? "?"}): ${memErr.message}`,
    );
  }

  revalidatePath("/admin");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/setup");
  redirect(`/admin/setup?customer=${data!.id}&step=2`);
}

export async function saveSetupGoalsAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  await requireAdminAccess(customerId);
  const supabase = await createClient();

  const selected = formData.getAll("goal_type").map(String);
  const { data: templates } = await supabase
    .from("goal_templates")
    .select("*")
    .eq("enabled", true);

  // Replace selections
  await supabase.from("project_goals").delete().eq("customer_id", customerId);

  const rows = (templates ?? [])
    .filter((t) => selected.includes(t.goal_type))
    .map((t, i) => ({
      customer_id: customerId,
      goal_type: t.goal_type,
      title: t.title,
      description: t.description,
      selected: true,
      priority: (i + 1) * 10,
      configuration: {},
    }));

  if (rows.length) {
    const { error } = await supabase.from("project_goals").insert(rows);
    if (error) throw new Error(error.message);
  }

  revalidatePath("/admin/setup");
  redirect(`/admin/setup?customer=${customerId}&step=3`);
}

export async function saveSetupAdaptersAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  const ctx = await requireAdminAccess(customerId);
  const supabase = await createClient();
  const selectedIds = [
    ...new Set(formData.getAll("adapter_id").map(String).filter(Boolean)),
  ];

  if (selectedIds.length === 0) {
    setupErrorRedirect(
      "Bitte mindestens einen Adapter auswählen, bevor Sie weitergehen.",
      customerId,
      3,
    );
  }

  const { error: delErr } = await supabase
    .from("customer_input_adapters")
    .delete()
    .eq("customer_id", customerId);
  if (delErr) {
    console.error("[onboarding] saveSetupAdapters delete", delErr);
    setupErrorRedirect(
      `Adapter-Auswahl konnte nicht aktualisiert werden: ${delErr.message}`,
      customerId,
      3,
    );
  }

  const rows = selectedIds.map((id) => ({
    customer_id: customerId,
    input_adapter_id: id,
    status: "selected" as const,
    selected_by: ctx.userId,
    configuration: {},
  }));

  let { error } = await supabase.from("customer_input_adapters").insert(rows);
  if (error) {
    const firstError = error;
    console.error("[onboarding] saveSetupAdapters insert", firstError);
    try {
      const admin = createAdminClient();
      const retry = await admin.from("customer_input_adapters").insert(rows);
      error = retry.error;
    } catch (e) {
      setupErrorRedirect(
        `Adapter speichern fehlgeschlagen: ${firstError.message}. Fallback: ${
          e instanceof Error ? e.message : "unbekannt"
        }`,
        customerId,
        3,
      );
    }
  }
  if (error) {
    setupErrorRedirect(
      `Adapter speichern fehlgeschlagen: ${error.message}`,
      customerId,
      3,
    );
  }

  const { count, error: countErr } = await supabase
    .from("customer_input_adapters")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId);
  if (countErr || !count) {
    setupErrorRedirect(
      "Adapter wurden nicht gespeichert (keine Zeilen nach dem Insert). Bitte erneut versuchen.",
      customerId,
      3,
    );
  }

  revalidatePath("/admin/setup");
  redirect(`/admin/setup?customer=${customerId}&step=4`);
}

export async function saveAdapterConfigurationAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  await requireAdminAccess(customerId);
  const supabase = await createClient();

  const { data: rows } = await supabase
    .from("customer_input_adapters")
    .select("id, input_adapter_id, input_adapters(adapter_key, configuration_schema)")
    .eq("customer_id", customerId);

  for (const row of rows ?? []) {
    const adapter = row.input_adapters as
      | { adapter_key: string; configuration_schema: { properties?: Record<string, unknown> } }
      | { adapter_key: string; configuration_schema: { properties?: Record<string, unknown> } }[]
      | null;
    const meta = Array.isArray(adapter) ? adapter[0] : adapter;
    if (!meta) continue;
    const props = meta.configuration_schema?.properties ?? {};
    const configuration: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      const field = `cfg__${row.id}__${key}`;
      const raw = formData.get(field);
      if (raw == null || raw === "") continue;
      const schema = props[key] as { type?: string };
      if (schema?.type === "integer") configuration[key] = Number(raw);
      else if (schema?.type === "boolean") configuration[key] = String(raw) === "true";
      else configuration[key] = String(raw);
    }
    await supabase
      .from("customer_input_adapters")
      .update({ configuration, status: "configured" })
      .eq("id", row.id)
      .eq("customer_id", customerId);
  }

  revalidatePath("/admin/setup");
  redirect(`/admin/setup?customer=${customerId}&step=5`);
}

export async function generateWorkflowAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  await requireAdminAccess(customerId);
  const supabase = await createClient();

  const [{ data: goals }, { data: adapters }, { data: templates }, { data: existing }] =
    await Promise.all([
      supabase
        .from("project_goals")
        .select("id, goal_type")
        .eq("customer_id", customerId)
        .eq("selected", true),
      supabase
        .from("customer_input_adapters")
        .select("id, configuration, input_adapters(id, adapter_key)")
        .eq("customer_id", customerId),
      supabase.from("workflow_templates").select("*").eq("enabled", true),
      supabase
        .from("customer_workflows")
        .select("id")
        .eq("customer_id", customerId)
        .eq("status", "active")
        .maybeSingle(),
    ]);

  if (existing?.id) {
    // Idempotent: archive previous active workflow before creating a new one
    await supabase
      .from("customer_workflows")
      .update({ status: "archived" })
      .eq("id", existing.id);
  }

  const goalTypes = (goals ?? []).map((g) => g.goal_type as string);
  const adapterKeys = (adapters ?? [])
    .map((a) => {
      const ia = a.input_adapters as
        | { adapter_key: string }
        | { adapter_key: string }[]
        | null;
      const m = Array.isArray(ia) ? ia[0] : ia;
      return m?.adapter_key;
    })
    .filter((k): k is string => Boolean(k));

  const configuration: Record<string, unknown> = {};
  for (const a of adapters ?? []) {
    const ia = a.input_adapters as
      | { adapter_key: string }
      | { adapter_key: string }[]
      | null;
    const m = Array.isArray(ia) ? ia[0] : ia;
    if (m?.adapter_key) configuration[m.adapter_key] = a.configuration;
  }

  const templateInputs: WorkflowTemplateInput[] = (templates ?? []).map((t) => ({
    id: t.id,
    template_key: t.template_key,
    name: t.name,
    version: t.version,
    goal_types: (t.goal_types as string[]) ?? [],
    required_adapter_keys: (t.required_adapter_keys as string[]) ?? [],
    optional_adapter_keys: (t.optional_adapter_keys as string[]) ?? [],
    priority: t.priority ?? 100,
    enabled: t.enabled,
  }));

  const stepTemplatesByTemplateId: Record<string, WorkflowStepTemplateInput[]> = {};
  for (const t of templateInputs) {
    const { data: steps } = await supabase
      .from("workflow_step_templates")
      .select("*")
      .eq("workflow_template_id", t.id)
      .order("sort_order");
    stepTemplatesByTemplateId[t.id] = (steps ?? []).map((s) => ({
      id: s.id,
      step_key: s.step_key,
      phase_key: s.phase_key,
      title: s.title,
      short_description: s.short_description ?? "",
      detailed_instructions: s.detailed_instructions ?? "",
      info_text: s.info_text ?? "",
      sort_order: s.sort_order,
      required: s.required,
      completion_type: s.completion_type,
      pipeline_step_key: s.pipeline_step_key,
      adapter_key: s.adapter_key,
      visible_when: (s.visible_when ?? {}) as VisibleWhen,
      prerequisites: (s.prerequisites as string[]) ?? [],
      expected_outputs: (s.expected_outputs as string[]) ?? [],
      estimated_effort_text: s.estimated_effort_text,
      responsible_role: s.responsible_role ?? "customer_admin",
    }));
  }

  const generated = generateCustomerWorkflow({
    customerId,
    goalTypes,
    adapterKeys,
    configuration,
    templates: templateInputs,
    stepTemplatesByTemplateId,
  });

  const { data: wf, error: wfErr } = await supabase
    .from("customer_workflows")
    .insert({
      customer_id: customerId,
      workflow_template_id: generated.template.id,
      template_key: generated.template.template_key,
      template_version: generated.template.version,
      status: "active",
      generated_from_goal_ids: (goals ?? []).map((g) => g.id),
      generated_from_adapter_ids: (adapters ?? []).map((a) => a.id),
      summary: generated.summary,
    })
    .select("id")
    .single();

  if (wfErr || !wf) throw new Error(wfErr?.message ?? "Workflow konnte nicht angelegt werden.");

  const stepRows = generated.steps.map((s) => ({
    customer_workflow_id: wf.id,
    customer_id: customerId,
    step_key: s.step_key,
    phase_key: s.phase_key,
    title: s.title,
    short_description: s.short_description,
    detailed_instructions: s.detailed_instructions,
    info_text: s.info_text,
    sort_order: s.sort_order,
    required: s.required,
    completion_type: s.completion_type,
    pipeline_step_key: s.pipeline_step_key,
    adapter_key: s.adapter_key,
    status: s.status,
    completed: false,
    prerequisites: s.prerequisites,
    expected_outputs: s.expected_outputs,
    responsible_role: s.responsible_role,
    metadata: s.metadata,
  }));

  const { error: stepErr } = await supabase
    .from("customer_workflow_steps")
    .insert(stepRows);
  if (stepErr) throw new Error(stepErr.message);

  await supabase
    .from("customers")
    .update({ status: "onboarding" })
    .eq("id", customerId);

  const { data: customerRow } = await supabase
    .from("customers")
    .select("slug")
    .eq("id", customerId)
    .maybeSingle();
  const projectKey = (customerRow?.slug ?? "").trim() || "P01";

  revalidatePath("/admin");
  revalidatePath("/admin/dashboard");
  // Hauptschritt Validierung (Control-Tables-Import).
  redirect(`/admin/steps/4?project=${encodeURIComponent(projectKey)}`);
}

export async function completeManualStepAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  await requireAdminAccess(customerId);
  // Manuelles „Schritt abschließen“ ist deaktiviert — nur technische Aktionen.
  const { data: customerRow } = await (
    await createClient()
  )
    .from("customers")
    .select("slug")
    .eq("id", customerId)
    .maybeSingle();
  const projectKey = (customerRow?.slug ?? "").trim() || "P01";
  redirect(`/admin/steps/4?project=${encodeURIComponent(projectKey)}`);
}

async function refreshStepStatuses(customerId: string, workflowId: string) {
  const supabase = await createClient();
  const { data: steps } = await supabase
    .from("customer_workflow_steps")
    .select("id, step_key, status, completed, prerequisites")
    .eq("customer_workflow_id", workflowId)
    .eq("customer_id", customerId);

  const map = recomputeStepStatuses(
    (steps ?? []).map((s) => ({
      step_key: s.step_key,
      status: s.status,
      completed: s.completed,
      prerequisites: (s.prerequisites as string[]) ?? [],
    })),
  );

  for (const s of steps ?? []) {
    const next = map.get(s.step_key);
    if (!next || next === s.status) continue;
    if (s.completed || s.status === "skipped") continue;
    if (["in_progress", "failed", "waiting_for_input"].includes(s.status)) continue;
    await supabase
      .from("customer_workflow_steps")
      .update({ status: next })
      .eq("id", s.id)
      .eq("customer_id", customerId);
  }
}

export async function createPipelineRunStubAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  const stepId = String(formData.get("step_id") ?? "");
  const ctx = await requireAdminAccess(customerId);
  const supabase = await createClient();

  const { data: step } = await supabase
    .from("customer_workflow_steps")
    .select("*")
    .eq("id", stepId)
    .eq("customer_id", customerId)
    .single();

  if (!step?.pipeline_step_key) {
    throw new Error("Kein Pipeline-Schritt verknüpft.");
  }
  if (step.status === "blocked") throw new Error("Schritt ist blockiert.");

  let def;
  try {
    def = getPipelineStep(step.pipeline_step_key);
  } catch {
    throw new Error("Pipeline-Schritt ist nicht in der Registry registriert.");
  }
  if (def.status !== "active") {
    throw new Error("Pipeline-Schritt ist in der Registry nicht aktiv.");
  }

  const { error } = await supabase.from("pipeline_runs").insert({
    customer_id: customerId,
    workflow_step_id: stepId,
    pipeline_step_key: step.pipeline_step_key,
    status: "ready",
    initiated_by: ctx.userId,
    input_summary: {
      note: "Dev-Stub: kein automatischer Hintergrundlauf. Status ready — nicht completed.",
      registry_title: def.title,
    },
  });
  if (error) throw new Error(error.message);

  await supabase
    .from("customer_workflow_steps")
    .update({
      status: "waiting_for_input",
      result_summary:
        "Pipeline-Run angelegt (ready). Noch kein automatischer Erfolg — bitte externen Lauf verknüpfen.",
    })
    .eq("id", stepId)
    .eq("customer_id", customerId);

  revalidatePath("/admin/pipeline");
  revalidatePath("/admin/extraction");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/steps", "layout");
}

export async function updateCustomerProductModuleAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "").trim();
  await requireAdminAccess(customerId);
  const productModuleRaw = String(formData.get("product_module") ?? "general")
    .trim()
    .toLowerCase();
  if (!isAppModuleKey(productModuleRaw)) {
    setupErrorRedirect("Ungültige Projekt-Klassifizierung.", customerId);
  }
  const productModule: AppModuleKey = productModuleRaw as AppModuleKey;

  const admin = createAdminClient();
  const { error } = await admin
    .from("customers")
    .update({ product_module: productModule })
    .eq("id", customerId);
  if (error) {
    setupErrorRedirect(
      `Klassifizierung konnte nicht gespeichert werden: ${error.message}`,
      customerId,
    );
  }

  // Zugeordnete Anwender-Profile an die Projekt-Klassifizierung anpassen.
  const flags = moduleFlagsFromProduct(productModule);
  await admin
    .from("app_user_profiles")
    .update({
      ...flags,
      updated_at: new Date().toISOString(),
    })
    .eq("customer_id", customerId)
    .neq("role", "general_admin");

  // Lokales Projekt-Domain-Profil mitführen (keine parallelen Widersprüche).
  try {
    const { fileProjectRepository } = await import(
      "@/lib/localAuth/projectRepository"
    );
    const { domainProfileIdForAppModule } = await import(
      "@/lib/domain/capabilities"
    );
    const projects = await fileProjectRepository.list();
    const local = projects.find((p) => p.id === customerId);
    if (local) {
      await fileProjectRepository.upsert({
        ...local,
        domain_profile_id: domainProfileIdForAppModule(productModule),
      });
    }
  } catch {
    /* optional local sync */
  }

  revalidatePath("/admin/setup");
  redirect(`/admin/setup?customer=${customerId}&step=1`);
}

const BRANDING_BUCKET = "customer-branding";
const BRANDING_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

/** Upload project branding image → customers.logo_url (public bucket). */
export async function uploadCustomerLogoAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "").trim();
  await requireAdminAccess(customerId);

  const raw = formData.get("logo");
  if (!(raw instanceof File) || raw.size <= 0) {
    setupErrorRedirect("Bitte eine Bilddatei auswählen.", customerId);
    return;
  }
  const file = raw;
  if (file.size > 2 * 1024 * 1024) {
    setupErrorRedirect("Bild darf maximal 2 MB groß sein.", customerId);
    return;
  }
  const ext = BRANDING_MIME[file.type];
  if (!ext) {
    setupErrorRedirect(
      "Ungültiges Format. Erlaubt: PNG, JPEG, WebP, GIF, SVG.",
      customerId,
    );
    return;
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    setupErrorRedirect(
      e instanceof Error
        ? e.message
        : "Service-Role nicht konfiguriert — Logo-Upload nicht möglich.",
      customerId,
    );
    return;
  }

  const path = `${customerId}/logo.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage
    .from(BRANDING_BUCKET)
    .upload(path, buffer, {
      contentType: file.type,
      upsert: true,
      cacheControl: "3600",
    });
  if (uploadError) {
    setupErrorRedirect(
      `Logo-Upload fehlgeschlagen: ${uploadError.message}`,
      customerId,
    );
    return;
  }

  const { data: pub } = admin.storage.from(BRANDING_BUCKET).getPublicUrl(path);
  const logoUrl = `${pub.publicUrl}?v=${Date.now()}`;

  const { error: updErr } = await admin
    .from("customers")
    .update({ logo_url: logoUrl })
    .eq("id", customerId);
  if (updErr) {
    setupErrorRedirect(
      `Logo gespeichert, DB-Update fehlgeschlagen: ${updErr.message}`,
      customerId,
    );
    return;
  }

  revalidatePath("/admin");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/setup");
  revalidatePath("/app", "layout");
  redirect(`/admin/setup?customer=${customerId}&step=1&logo=1`);
}

export async function inviteCustomerUserAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  const ctx = await requireAdminAccess(customerId);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "customer_user") as
    | "customer_admin"
    | "customer_user";
  if (!email || !email.includes("@")) {
    throw new Error("Gültige E-Mail ist erforderlich.");
  }
  if (password.length < 8) {
    throw new Error("Passwort muss mindestens 8 Zeichen haben.");
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    throw new Error(
      e instanceof Error
        ? e.message
        : "Service-Role nicht konfiguriert — User-Anlage nicht möglich.",
    );
  }

  const { data: customer, error: customerError } = await admin
    .from("customers")
    .select("id, name, product_module")
    .eq("id", customerId)
    .maybeSingle();
  if (customerError || !customer) {
    throw new Error("Projekt nicht gefunden.");
  }

  const productModule: AppModuleKey = isAppModuleKey(
    String(customer.product_module ?? "general"),
  )
    ? (customer.product_module as AppModuleKey)
    : "general";
  const flags = moduleFlagsFromProduct(productModule);

  const listed = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listed.error) throw new Error(listed.error.message);

  let userId =
    listed.data.users.find(
      (u) => (u.email ?? "").toLowerCase() === email,
    )?.id ?? null;

  if (!userId) {
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: displayName || email,
        invited_by: ctx.userId,
        customer_id: customerId,
      },
    });
    if (created.error || !created.data.user) {
      throw new Error(
        created.error?.message ?? "Auth-User konnte nicht angelegt werden.",
      );
    }
    userId = created.data.user.id;
  } else {
    // Bestehender User: Passwort auf den angegebenen Klartext-Wert setzen.
    const updated = await admin.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
      user_metadata: {
        display_name: displayName || email,
        invited_by: ctx.userId,
        customer_id: customerId,
      },
    });
    if (updated.error) {
      throw new Error(
        `User existiert, Passwort konnte nicht gesetzt werden: ${updated.error.message}`,
      );
    }
  }

  const { error: memErr } = await admin.from("customer_memberships").upsert(
    {
      customer_id: customerId,
      user_id: userId,
      role,
      status: "active",
    },
    { onConflict: "customer_id,user_id" },
  );
  if (memErr) throw new Error(memErr.message);

  const profileRole = role === "customer_admin" ? "admin" : "user";
  const { data: existingProfile } = await admin
    .from("app_user_profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingProfile?.role === "general_admin") {
    // Platform-Admin nicht herabstufen — nur Mitgliedschaft reicht.
  } else {
    const { error: profileErr } = await admin.from("app_user_profiles").upsert(
      {
        user_id: userId,
        role: profileRole,
        customer_id: customerId,
        display_name: displayName || email,
        ...flags,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (profileErr) {
      throw new Error(
        `Mitgliedschaft ok, Profil fehlgeschlagen: ${profileErr.message}`,
      );
    }
  }

  revalidatePath("/admin/users");
  revalidatePath("/admin/dashboard");
  redirect(`/admin/users?customer=${customerId}&invited=1`);
}

export async function resolveHomeDestination() {
  const ctx = await requireUser();
  if (canAccessProjectConsole(ctx)) {
    redirect("/admin/dashboard");
  }
  if (canAccessApp(ctx)) {
    redirect("/app");
  }
  redirect("/");
}

function dashboardErrorRedirect(message: string, customerId?: string) {
  const q = new URLSearchParams();
  if (customerId) q.set("customer", customerId);
  q.set("error", message);
  redirect(`/admin/dashboard?${q.toString()}`);
}

/** Platform-Admin: Kunde/Projekt inkl. abhängiger Onboarding-Daten löschen. */
export async function deleteCustomerAction(formData: FormData) {
  const ctx = await requireAdminAccess();
  if (!ctx.isPlatformAdmin) {
    dashboardErrorRedirect("Nur Platform Admins dürfen Projekte löschen.");
  }

  const customerId = String(formData.get("customer_id") ?? "").trim();
  const confirmName = String(formData.get("confirm_name") ?? "").trim();
  if (!customerId) {
    dashboardErrorRedirect("Kein Projekt ausgewählt.");
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    dashboardErrorRedirect(
      e instanceof Error
        ? e.message
        : "Service-Role fehlt — vollständiges Löschen nicht möglich.",
      customerId,
    );
    return;
  }

  // Wie bei createCustomer: App-Recht general_admin mit platform_admins synchron halten
  // (Fallback-Löschen über User-Client braucht is_platform_admin()).
  try {
    await admin.from("platform_admins").upsert(
      { user_id: ctx.userId, created_by: ctx.userId },
      { onConflict: "user_id" },
    );
  } catch (error) {
    console.error("[onboarding] deleteCustomer platform_admins sync", error);
  }

  // Service-Role laden — unabhängig von Session-RLS.
  const { data: customer, error: loadError } = await admin
    .from("customers")
    .select("id, name, slug")
    .eq("id", customerId)
    .maybeSingle();

  if (loadError || !customer) {
    dashboardErrorRedirect(
      loadError
        ? `Projekt nicht ladbar: ${loadError.message}`
        : "Projekt nicht gefunden.",
      customerId,
    );
  }

  if (confirmName !== String(customer!.name ?? "").trim()) {
    dashboardErrorRedirect(
      "Löschen abgebrochen: der Bestätigungsname stimmt nicht überein.",
      customerId,
    );
  }

  // Storage best-effort vor dem DB-Cascade bereinigen
  try {
    const { data: uploads } = await admin
      .from("source_uploads")
      .select("storage_path")
      .eq("customer_id", customerId);

    const paths = (uploads ?? [])
      .map((u) => u.storage_path as string)
      .filter(Boolean);
    if (paths.length) {
      await admin.storage.from("customer-uploads").remove(paths);
    }

    const { data: listed } = await admin.storage
      .from("customer-uploads")
      .list(customerId, { limit: 1000 });
    if (listed?.length) {
      await admin.storage
        .from("customer-uploads")
        .remove(listed.map((f) => `${customerId}/${f.name}`));
    }
  } catch (error) {
    console.error("[onboarding] deleteCustomer storage cleanup", error);
  }

  // app_user_profiles.customer_id ist ON DELETE SET NULL, aber die Check-Constraint
  // app_user_profiles_admin_needs_customer erlaubt NULL nur für general_admin.
  // Vor dem Cascade Profile umhängen bzw. freigeben, sonst scheitert DELETE.
  {
    const { data: profiles, error: profileLoadError } = await admin
      .from("app_user_profiles")
      .select("user_id, role, customer_id")
      .eq("customer_id", customerId);
    if (profileLoadError) {
      console.error(
        "[onboarding] deleteCustomer profiles load",
        profileLoadError.message,
      );
    }
    for (const profile of profiles ?? []) {
      if (profile.role === "general_admin") {
        const { error: clearError } = await admin
          .from("app_user_profiles")
          .update({ customer_id: null })
          .eq("user_id", profile.user_id);
        if (clearError) {
          console.error(
            "[onboarding] deleteCustomer clear admin customer_id",
            clearError.message,
          );
        }
        continue;
      }

      const { data: otherMemberships } = await admin
        .from("customer_memberships")
        .select("customer_id")
        .eq("user_id", profile.user_id)
        .neq("customer_id", customerId)
        .limit(1);
      const nextCustomerId = otherMemberships?.[0]?.customer_id ?? null;

      if (nextCustomerId) {
        const { error: reassignError } = await admin
          .from("app_user_profiles")
          .update({ customer_id: nextCustomerId })
          .eq("user_id", profile.user_id);
        if (reassignError) {
          console.error(
            "[onboarding] deleteCustomer reassign profile",
            reassignError.message,
          );
          dashboardErrorRedirect(
            `Projekt konnte nicht gelöscht werden: ${reassignError.message}`,
            customerId,
          );
        }
      } else {
        // Letztes Projekt dieses Anwenders — Profil entfernen, sonst Check-Constraint.
        const { error: deleteProfileError } = await admin
          .from("app_user_profiles")
          .delete()
          .eq("user_id", profile.user_id);
        if (deleteProfileError) {
          console.error(
            "[onboarding] deleteCustomer remove orphan profile",
            deleteProfileError.message,
          );
          dashboardErrorRedirect(
            `Projekt konnte nicht gelöscht werden: ${deleteProfileError.message}`,
            customerId,
          );
        }
      }
    }
  }

  // Service-Role: Cascade löscht Memberships, Workflow, Uploads, Gates usw.
  // .select() ist nötig — ohne Returning wirkt „0 Zeilen“ wie Erfolg.
  const { data: deleted, error } = await admin
    .from("customers")
    .delete()
    .eq("id", customerId)
    .select("id");

  if (error || !deleted?.length) {
    console.error(
      "[onboarding] deleteCustomer",
      error?.message ?? "keine Zeile gelöscht",
    );
    const supabase = await createClient();
    const retry = await supabase
      .from("customers")
      .delete()
      .eq("id", customerId)
      .select("id");
    if (retry.error || !retry.data?.length) {
      dashboardErrorRedirect(
        `Projekt konnte nicht gelöscht werden${
          error?.message || retry.error?.message
            ? `: ${error?.message || retry.error?.message}`
            : " (keine Zeile entfernt)."
        }`,
        customerId,
      );
    }
  }

  revalidatePath("/admin");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/setup");
  revalidatePath("/");
  redirect("/admin/dashboard?deleted=1");
}
