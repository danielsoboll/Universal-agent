import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  canMutateProjectSetup,
  primaryCustomerId,
  requireProjectConsoleAccess,
} from "@/lib/onboarding/access";
import { applyCustomerScopeFilter } from "@/lib/onboarding/customerQuery";
import { SetupStepDetail } from "@/components/admin/setup/SetupStepDetail";
import { ExportGroupsPanel } from "@/components/admin/exportGroups/ExportGroupsPanel";
import { ProjectAdminGateLink } from "@/components/admin/ProjectAdminGate";
import { computeExportGroupsOverview } from "@/lib/admin/exportGroups/computeExportGroups";
import {
  computeSetupOverview,
  parseSetupStepId,
  type ProjectSetupContext,
} from "@/lib/admin/setupMainSteps";
import { Stage2StructurePanel } from "@/components/admin/setup/Stage2StructurePanel";
import { DatenbasisPanel } from "@/components/admin/datenbasis/DatenbasisPanel";
import {
  computeDatenbasisOverview,
  reconcileSetupStage2,
} from "@/lib/admin/datenbasis";
import { getLocalDataRoot } from "@/lib/localData/root";

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

  let groupsSlot: React.ReactNode = null;
  if ((stepId === 4 || stepId === 5) && step.active) {
    const groupsOverview = computeExportGroupsOverview({
      projectKey,
      customerId,
    });
    const mode = stepId === 4 ? "validation" : "feintuning";
    groupsSlot = (
      <ExportGroupsPanel
        groups={groupsOverview.groups}
        stepId={stepId}
        customerId={customerId}
        mode={mode}
      />
    );
  }

  let stage2Slot: React.ReactNode = null;
  if (stepId === 2 && step.active) {
    try {
      getLocalDataRoot();
      const stage2 = reconcileSetupStage2(projectKey);
      stage2Slot = (
        <Stage2StructurePanel
          initial={stage2}
          projectKey={projectKey}
          customerId={customerId}
          canRun={canMutate}
        />
      );
    } catch {
      stage2Slot = (
        <p className="rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3 text-[1.0625rem] text-[var(--muted)]">
          LOCAL_DATA_ROOT nicht verfügbar — Ordnerstruktur kann nicht geprüft
          werden.
        </p>
      );
    }
  }

  let datenbasisSlot: React.ReactNode = null;
  if (stepId === 3 && step.active) {
    const db = computeDatenbasisOverview({ projectKey, customerId });
    datenbasisSlot = <DatenbasisPanel types={db.types} />;
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

  const hideSubTasks =
    stepId === 2 || stepId === 3 || stepId === 4 || stepId === 5;

  return (
    <SetupStepDetail step={step} hideSubTasks={hideSubTasks}>
      {step.locked ? (
        <p className="rounded-[12px] border border-[var(--border)] bg-[var(--panel)] p-3 text-[1.0625rem] text-[var(--muted)]">
          Dieser Schritt ist gesperrt. Schließen Sie zuerst den vorherigen
          Hauptschritt zu 100&nbsp;% ab.
        </p>
      ) : null}
      {actionSlot}
      {stage2Slot}
      {datenbasisSlot}
      {groupsSlot}
    </SetupStepDetail>
  );
}
