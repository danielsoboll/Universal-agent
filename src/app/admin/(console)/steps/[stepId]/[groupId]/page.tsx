import { notFound, redirect } from "next/navigation";
import {
  canMutateProjectSetup,
  primaryCustomerId,
  requireProjectConsoleAccess,
} from "@/lib/onboarding/access";
import { applyCustomerScopeFilter } from "@/lib/onboarding/customerQuery";
import { createClient } from "@/lib/supabase/server";
import { parseSetupStepId } from "@/lib/admin/setupMainSteps";
import {
  computeExportGroupsOverview,
  parseExportGroupId,
} from "@/lib/admin/exportGroups/computeExportGroups";
import { ExportGroupDetailView } from "@/components/admin/exportGroups/ExportGroupDetailView";
import { ControlTablesFahrplanView } from "@/components/admin/fahrplan/ControlTablesFahrplanView";
import { getControlTablesFahrplanAction } from "@/actions/controlTablesFahrplan";
import { createInitialFahrplanState } from "@/lib/rebuild/controlTablesFahrplan";
import { PressNavigateLink } from "@/components/ui/PressNavigateLink";
import {
  getExportTypeConfig,
  isExportTypeId,
  reconcileSetupStage2,
  isStage2Done,
  loadMessageIdocStatus,
  loadMessageIdocRawManifest,
  describePlannedCanonicalModel,
} from "@/lib/admin/datenbasis";
import {
  computeUnlockMap,
  reconcileManifest,
} from "@/lib/admin/datenbasis/manifestStore";
import { ExportTypeDetailView } from "@/components/admin/datenbasis/ExportTypeDetailView";
import { getLocalDataRoot } from "@/lib/localData/root";
import { resolveBoundProjectKey } from "@/lib/localData/resolveDataProjectKey";

const ACTION_BTN =
  "btn btn-secondary btn-quiet flex min-h-12 w-full items-center justify-center";

export default async function AdminExportGroupDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ stepId: string; groupId: string }>;
  searchParams: Promise<{ customer?: string; project?: string }>;
}) {
  const ctx = await requireProjectConsoleAccess();
  const { stepId: stepIdRaw, groupId: groupIdRaw } = await params;
  const sp = await searchParams;
  const stepId = parseSetupStepId(stepIdRaw);
  if (!stepId || (stepId !== 3 && stepId !== 4 && stepId !== 5)) {
    notFound();
  }

  const canMutate = canMutateProjectSetup(ctx);
  const supabase = await createClient();

  let customersQuery = supabase
    .from("customers")
    .select("id, name, slug, status, product_module, landscape_label")
    .order("created_at", { ascending: false });
  customersQuery = applyCustomerScopeFilter(customersQuery, ctx);
  let { data: customers, error: customersError } = await customersQuery;
  if (
    customersError &&
    (/product_module/i.test(customersError.message) ||
      /landscape_label/i.test(customersError.message))
  ) {
    let fallbackQuery = supabase
      .from("customers")
      .select("id, name, slug, status")
      .order("created_at", { ascending: false });
    fallbackQuery = applyCustomerScopeFilter(fallbackQuery, ctx);
    const retry = await fallbackQuery;
    customers = (retry.data ?? []).map((c) => ({
      ...c,
      product_module: null as string | null,
      landscape_label: null as string | null,
    }));
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
  const projectKey = resolveBoundProjectKey({
    slug: selectedCustomer?.slug,
    landscapeLabel: (selectedCustomer as { landscape_label?: string | null } | null)
      ?.landscape_label,
    customerId,
    hint: (sp.project ?? "").trim() || null,
  });

  const customerQs = `?customer=${encodeURIComponent(customerId)}`;
  const backHref = `/admin/steps/${stepId}${customerQs}${
    sp.project?.trim()
      ? `&project=${encodeURIComponent(sp.project.trim())}`
      : ""
  }`;

  // Stage 3: Datenbasis export-type detail
  if (stepId === 3 && isExportTypeId(groupIdRaw)) {
    const config = getExportTypeConfig(groupIdRaw);
    if (!config) notFound();

    getLocalDataRoot();
    const stage2 = reconcileSetupStage2(projectKey);
    const unlocks = computeUnlockMap(projectKey, isStage2Done(stage2));
    const manifest = reconcileManifest(
      projectKey,
      config.id,
      Boolean(unlocks[config.id]),
    );

    const messageIdoc =
      config.id === "message-idoc-config"
        ? {
            status: loadMessageIdocStatus(projectKey),
            manifest: loadMessageIdocRawManifest(projectKey),
            plannedModel: describePlannedCanonicalModel(),
          }
        : undefined;

    return (
      <div className="space-y-3">
        <PressNavigateLink href={backHref} className={ACTION_BTN}>
          Zurück zur Datenbasis
        </PressNavigateLink>
        <ExportTypeDetailView
          config={config}
          initial={manifest}
          projectKey={projectKey}
          customerId={customerId}
          canRun={canMutate}
          messageIdoc={messageIdoc}
        />
      </div>
    );
  }

  // Stages 4–5: legacy export groups (+ CT fahrplan)
  const groupId = parseExportGroupId(groupIdRaw);
  if (!groupId || stepId === 3) {
    notFound();
  }

  const overview = computeExportGroupsOverview({ projectKey, customerId });
  const group = overview.groups.find((g) => g.id === groupId);
  if (!group) notFound();

  let fahrplanSlot: React.ReactNode = null;
  const showFahrplan =
    groupId === "zy-tables" &&
    ((stepId === 4 && !group.validation.locked) ||
      (stepId === 5 && !group.feintuning.locked));
  if (showFahrplan) {
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
          {stepId === 4
            ? "Control-Tables Validierung (bestehender Fahrplan)"
            : "Control-Tables Wissen & Suche (bestehender Fahrplan)"}
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

  return (
    <div className="space-y-3">
      <PressNavigateLink href={backHref} className={ACTION_BTN}>
        Zurück zum Hauptschritt
      </PressNavigateLink>
      <ExportGroupDetailView
        group={group}
        stepId={stepId}
        projectKey={projectKey}
        canMutate={canMutate}
      >
        {fahrplanSlot}
      </ExportGroupDetailView>
    </div>
  );
}
