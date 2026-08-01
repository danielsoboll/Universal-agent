import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  canMutateProjectSetup,
  primaryCustomerId,
  requireProjectConsoleAccess,
} from "@/lib/onboarding/access";
import { applyCustomerScopeFilter } from "@/lib/onboarding/customerQuery";
import { SetupStepDetail } from "@/components/admin/setup/SetupStepDetail";
import { ControlTablesFahrplanView } from "@/components/admin/fahrplan/ControlTablesFahrplanView";
import { ProjectAdminGateLink } from "@/components/admin/ProjectAdminGate";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";
import { getControlTablesFahrplanAction } from "@/actions/controlTablesFahrplan";
import { createInitialFahrplanState } from "@/lib/rebuild/controlTablesFahrplan";
import {
  computeSetupOverview,
  parseSetupStepId,
  type ProjectSetupContext,
} from "@/lib/admin/setupMainSteps";

function resolveProjectKey(slug: string | null | undefined): string {
  const s = (slug ?? "").trim();
  return s || "P01";
}

const ACTION_BTN =
  "btn btn-secondary btn-quiet flex min-h-12 w-full items-center justify-center";

export default async function AdminSetupStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ stepId: string }>;
  searchParams: Promise<{ customer?: string; project?: string }>;
}) {
  const ctx = await requireProjectConsoleAccess();
  const { stepId: stepIdRaw } = await params;
  const sp = await searchParams;
  const stepId = parseSetupStepId(stepIdRaw);
  if (!stepId) notFound();

  const canMutate = canMutateProjectSetup(ctx);
  const supabase = await createClient();

  let customersQuery = supabase
    .from("customers")
    .select("id, name, slug, status, product_module")
    .order("created_at", { ascending: false });
  customersQuery = applyCustomerScopeFilter(customersQuery, ctx);

  let { data: customers, error: customersError } = await customersQuery;
  if (customersError && /product_module/i.test(customersError.message)) {
    let fallbackQuery = supabase
      .from("customers")
      .select("id, name, slug, status")
      .order("created_at", { ascending: false });
    fallbackQuery = applyCustomerScopeFilter(fallbackQuery, ctx);
    const retry = await fallbackQuery;
    customers = (retry.data ?? []).map((c) => ({
      ...c,
      product_module: null as string | null,
    }));
    customersError = retry.error;
  }
  if (customersError) {
    console.error("[admin/steps] customers", customersError.message);
  }
  const customerId =
    sp.customer ||
    customers?.[0]?.id ||
    primaryCustomerId(ctx) ||
    undefined;

  if (!customerId) {
    redirect("/admin/dashboard");
  }

  const selectedCustomer = customers?.find((c) => c.id === customerId) ?? null;
  const projectKey =
    (sp.project ?? "").trim() || resolveProjectKey(selectedCustomer?.slug);

  let hasGoals = false;
  let membershipCount = 0;
  let userMembershipCount = 0;

  const [goalsRes, membersRes] = await Promise.all([
    supabase
      .from("project_goals")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId),
    supabase
      .from("customer_memberships")
      .select("role")
      .eq("customer_id", customerId)
      .eq("status", "active"),
  ]);
  hasGoals = (goalsRes.count ?? 0) > 0;
  const rows = membersRes.data ?? [];
  membershipCount = rows.length;
  userMembershipCount = rows.filter((r) => r.role === "customer_user").length;

  const setupCtx: ProjectSetupContext = {
    customerId,
    customerName: selectedCustomer?.name ?? null,
    customerSlug: selectedCustomer?.slug ?? null,
    customerStatus: selectedCustomer?.status ?? null,
    productModule: selectedCustomer?.product_module ?? ctx.productModule ?? null,
    projectKey,
    hasGoals,
    membershipCount,
    userMembershipCount,
  };

  const overview = computeSetupOverview(setupCtx);
  const step = overview.steps.find((s) => s.id === stepId);
  if (!step) notFound();

  const customerQs = `?customer=${encodeURIComponent(customerId)}`;
  const step4Href = `/admin/steps/4${customerQs}${sp.project?.trim() ? `&project=${encodeURIComponent(sp.project.trim())}` : ""}`;

  let fahrplanSlot: React.ReactNode = null;
  if (stepId === 4 && step.active) {
    let payload: Awaited<ReturnType<typeof getControlTablesFahrplanAction>>;
    try {
      payload = await getControlTablesFahrplanAction(projectKey);
    } catch (error) {
      payload = {
        projectKey,
        access: {
          canView: true,
          canRun: canMutate,
          showTechDetails: ctx.isGeneralAdmin || ctx.isPlatformAdmin,
          roleLabel: ctx.roleLabel,
        },
        state: {
          ...createInitialFahrplanState(projectKey),
          overall: "action_required",
          steps: {
            ...createInitialFahrplanState(projectKey).steps,
            1: {
              id: 1,
              status: "failed",
              updated_at: new Date().toISOString(),
              result: {
                summary:
                  error instanceof Error
                    ? error.message
                    : "Lokale Daten nicht verfügbar (LOCAL_DATA_ROOT)",
                errors: [
                  error instanceof Error ? error.message : String(error),
                ],
              },
            },
          },
        },
      };
    }

    fahrplanSlot = (
      <section className="space-y-2">
        <p className="text-[0.875rem] font-medium text-[var(--muted)]">
          Validierung & Import (Control Tables)
        </p>
        <ControlTablesFahrplanView
          initial={payload.state}
          access={payload.access}
          projectKey={payload.projectKey}
          embedded
        />
      </section>
    );
  }

  if ((stepId === 3 || stepId === 5) && step.active) {
    // Navigation only — Projekt-Benutzer may view step 4 (actions gated there).
    fahrplanSlot = (
      <PressNavigateLink href={step4Href} className={ACTION_BTN}>
        {stepId === 3
          ? "Zur Validierung (Quelldateien prüfen)"
          : "Zur Validierung (Wissen & Suche)"}
      </PressNavigateLink>
    );
  }

  let actionSlot: React.ReactNode = null;
  if (stepId === 1 && step.active) {
    actionSlot = (
      <ProjectAdminGateLink
        canRun={canMutate}
        href={`/admin/setup${customerQs}`}
        className={ACTION_BTN}
      >
        Projekt-Setup öffnen
      </ProjectAdminGateLink>
    );
  }
  if (stepId === 6 && step.active) {
    actionSlot = (
      <div className="flex flex-col gap-2">
        {/* Anwenderbereich: Projekt-Benutzer dürfen öffnen */}
        <a href="/app" className={ACTION_BTN}>
          Anwenderbereich öffnen
        </a>
        <ProjectAdminGateLink
          canRun={canMutate}
          href={`/admin/users${customerQs}`}
          className={ACTION_BTN}
        >
          Anwender verwalten
        </ProjectAdminGateLink>
      </div>
    );
  }

  return (
    <SetupStepDetail step={step}>
      {step.locked ? (
        <p className="rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3 text-[1.0625rem] text-[var(--muted)]">
          Dieser Schritt ist gesperrt. Schließen Sie zuerst den vorherigen
          Hauptschritt zu 100&nbsp;% ab.
        </p>
      ) : null}
      {actionSlot}
      {fahrplanSlot}
    </SetupStepDetail>
  );
}
