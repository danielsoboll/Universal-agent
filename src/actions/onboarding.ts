"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  canAccessAdmin,
  canAccessApp,
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "kunde";
}

function setupErrorRedirect(message: string, customerId?: string, step?: number) {
  const q = new URLSearchParams();
  if (customerId) q.set("customer", customerId);
  if (step) q.set("step", String(step));
  q.set("error", message);
  redirect(`/admin/setup?${q.toString()}`);
}

export async function createCustomerAction(formData: FormData) {
  const ctx = await requireAdminAccess();
  if (!ctx.isPlatformAdmin) {
    setupErrorRedirect("Nur Platform Admins dürfen Kunden anlegen.");
  }

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const landscape = String(formData.get("landscape_label") ?? "").trim();
  let slug = String(formData.get("slug") ?? "").trim() || slugify(name);
  if (!name) setupErrorRedirect("Projektname ist erforderlich.");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .insert({
      name,
      slug,
      description: description || null,
      landscape_label: landscape || null,
      status: "onboarding",
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[onboarding] createCustomer", error?.message);
    setupErrorRedirect(
      "Kunde konnte nicht angelegt werden. Bitte Name/Slug prüfen und erneut versuchen.",
    );
  }

  // Platform admin is not auto-member; optional self-membership as admin for convenience
  await supabase.from("customer_memberships").upsert(
    {
      customer_id: data!.id,
      user_id: ctx.userId,
      role: "customer_admin",
      status: "active",
    },
    { onConflict: "customer_id,user_id" },
  );

  revalidatePath("/admin");
  redirect(`/admin/setup?customer=${data!.id}`);
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
  const selectedIds = formData.getAll("adapter_id").map(String);

  await supabase
    .from("customer_input_adapters")
    .delete()
    .eq("customer_id", customerId);

  if (selectedIds.length) {
    const { error } = await supabase.from("customer_input_adapters").insert(
      selectedIds.map((id) => ({
        customer_id: customerId,
        input_adapter_id: id,
        status: "selected",
        selected_by: ctx.userId,
        configuration: {},
      })),
    );
    if (error) throw new Error(error.message);
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

  revalidatePath("/admin");
  redirect(`/admin/checklist?customer=${customerId}`);
}

export async function completeManualStepAction(formData: FormData) {
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

  if (!step) throw new Error("Schritt nicht gefunden.");
  if (step.status === "blocked") throw new Error("Schritt ist blockiert.");
  if (
    step.completion_type !== "manual_checkbox" &&
    step.completion_type !== "approval" &&
    step.completion_type !== "configuration_completed"
  ) {
    throw new Error("Dieser Schritt ist nicht manuell abschließbar.");
  }

  await supabase
    .from("customer_workflow_steps")
    .update({
      completed: true,
      completed_at: new Date().toISOString(),
      completed_by: ctx.userId,
      status: "completed",
    })
    .eq("id", stepId)
    .eq("customer_id", customerId);

  if (step.completion_type === "approval" && step.step_key.includes("release")) {
    await supabase
      .from("customers")
      .update({ status: "active" })
      .eq("id", customerId);
  }

  await refreshStepStatuses(customerId, step.customer_workflow_id);
  revalidatePath("/admin/checklist");
  revalidatePath("/admin/dashboard");
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
  revalidatePath("/admin/checklist");
}

export async function inviteCustomerUserAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  await requireAdminAccess(customerId);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "customer_user") as
    | "customer_admin"
    | "customer_user";
  if (!email) throw new Error("E-Mail erforderlich.");

  // Membership by user_id requires existing auth user — look up via admin is service-role only.
  // For V1: store invite intent only if user exists in same session lookup is impossible with anon.
  // Use RPC-less approach: customer_admin enters user UUID temporarily OR we document service invite.
  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) {
    throw new Error(
      "V1: Bitte die User-ID (UUID) eines bestehenden Auth-Nutzers angeben. E-Mail-Einladung folgt später.",
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.from("customer_memberships").upsert(
    {
      customer_id: customerId,
      user_id: userId,
      role,
      status: "active",
    },
    { onConflict: "customer_id,user_id" },
  );
  if (error) throw new Error(error.message);
  revalidatePath("/admin/users");
}

export async function resolveHomeDestination() {
  const ctx = await requireUser();
  if (canAccessAdmin(ctx)) {
    redirect("/admin/dashboard");
  }
  if (canAccessApp(ctx)) {
    redirect("/app/search");
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

  const supabase = await createClient();
  const { data: customer, error: loadError } = await supabase
    .from("customers")
    .select("id, name, slug")
    .eq("id", customerId)
    .maybeSingle();

  if (loadError || !customer) {
    dashboardErrorRedirect("Projekt nicht gefunden oder kein Zugriff.", customerId);
  }

  if (confirmName !== customer!.name) {
    dashboardErrorRedirect(
      "Löschen abgebrochen: der Bestätigungsname stimmt nicht überein.",
      customerId,
    );
  }

  // Storage best-effort vor dem DB-Cascade bereinigen
  try {
    const admin = createAdminClient();
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

  const { error } = await supabase.from("customers").delete().eq("id", customerId);
  if (error) {
    console.error("[onboarding] deleteCustomer", error.message);
    dashboardErrorRedirect(
      "Projekt konnte nicht gelöscht werden. Bitte erneut versuchen.",
      customerId,
    );
  }

  revalidatePath("/admin");
  revalidatePath("/");
  redirect("/admin/dashboard?deleted=1");
}
