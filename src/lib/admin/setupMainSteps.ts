import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  assertProjectKey,
  resolveLocalPath,
  resolveProjectZonePath,
} from "@/lib/localData/paths";
import { DATA_ZONES, type DataZone } from "@/lib/localData/zones";
import {
  FAHRPLAN_STEP_IDS,
  type ControlTablesFahrplanState,
  type FahrplanStepId,
  type FahrplanStepStatus,
} from "@/lib/rebuild/controlTablesFahrplanTypes";
import { reconcileControlTablesFahrplanFromDisk } from "@/lib/rebuild/controlTablesFahrplan";
import { computeExportGroupsOverview } from "@/lib/admin/exportGroups/computeExportGroups";
import type {
  ExportGroupsOverview,
  PointStatus,
} from "@/lib/admin/exportGroups/types";
import {
  computeDatenbasisOverview,
  isStage2Done,
  reconcileSetupStage2,
} from "@/lib/admin/datenbasis";
import type { DatenbasisOverview } from "@/lib/admin/datenbasis/types";

/** Six main SAP data-import setup steps (exact UI titles). */
export const SETUP_MAIN_STEP_IDS = [1, 2, 3, 4, 5, 6] as const;
export type SetupMainStepId = (typeof SETUP_MAIN_STEP_IDS)[number];

export type SetupSubTaskStatus =
  | "open"
  | "locked"
  | "error"
  | "done"
  | "in_progress";

export type SetupMainStepUiStatus =
  | "locked"
  | "ready"
  | "in_progress"
  | "error"
  | "done";

export type SetupSubTask = {
  id: string;
  label: string;
  status: SetupSubTaskStatus;
  detail?: string;
};

export type SetupMainStepMeta = {
  id: SetupMainStepId;
  title: string;
  /** Short purpose shown under the step title on detail pages. */
  purpose: string;
  subTaskDefs: Array<{ id: string; label: string }>;
};

export const SETUP_MAIN_STEP_META: Record<SetupMainStepId, SetupMainStepMeta> = {
  1: {
    id: 1,
    title: "Initialisierung",
    purpose: "Projekt anlegen, Kunde setzen und Agent-Ziel speichern",
    subTaskDefs: [
      { id: "project_created", label: "Projekt angelegt" },
      { id: "customer_set", label: "Kunde gesetzt" },
      { id: "agent_goal", label: "Agent / Ziel definiert" },
      { id: "base_saved", label: "Basisdaten gespeichert" },
    ],
  },
  2: {
    id: 2,
    title: "Projekt- und Agent-Struktur",
    purpose: "Lokale Ordnerstruktur anlegen und manuell abschließen",
    subTaskDefs: [
      { id: "folders_ok", label: "Ordnerstruktur vorhanden" },
      { id: "manual_complete", label: "Manuell abgeschlossen" },
    ],
  },
  3: {
    id: 3,
    title: "Datenbasis",
    purpose:
      "Exporttypen geführt prüfen, konvertieren und freigeben (Klassen zuerst)",
    subTaskDefs: [
      { id: "classes", label: "Klassen freigegeben" },
      { id: "programs", label: "Programme vorbereitet" },
      { id: "other_types", label: "Weitere Typen (Scaffold)" },
    ],
  },
  4: {
    id: 4,
    title: "Validierung",
    purpose:
      "Pro erkannter Exportgruppe: Quelle, RAW, Konvertierung, Canonical prüfen",
    subTaskDefs: [
      { id: "source_recognized", label: "Quelle erkannt" },
      { id: "raw_checked", label: "RAW geprüft" },
      { id: "data_converted", label: "Daten konvertiert" },
      { id: "canonical_checked", label: "Canonical geprüft" },
    ],
  },
  5: {
    id: 5,
    title: "Export Teil 2 und Feintuning",
    purpose:
      "Pro validierter Gruppe: Wissen, Index, Direct-/KI-Suche und Plausibilität",
    subTaskDefs: [
      { id: "knowledge_build", label: "Wissensbestand aufgebaut" },
      { id: "index_search", label: "Index & Suche getestet" },
      { id: "deep_plaus", label: "KI-Suche & Plausibilität" },
    ],
  },
  6: {
    id: 6,
    title: "Schulung und Nutzung",
    purpose: "Anwenderbereich prüfen und Go-Live vorbereiten",
    subTaskDefs: [
      { id: "app_ready", label: "Anwenderbereich bereit" },
      { id: "views_checked", label: "User-/Admin-Ansichten geprüft" },
      { id: "standard_use", label: "Standardnutzung beschrieben" },
      { id: "golive", label: "Go-Live vorbereitet" },
    ],
  },
};

export type ProjectSetupContext = {
  customerId: string | null;
  customerName: string | null;
  customerSlug: string | null;
  customerStatus: string | null;
  productModule: string | null;
  projectKey: string;
  /** True when at least one project_goals row exists. */
  hasGoals: boolean;
  /** Active memberships for this customer (any role). */
  membershipCount: number;
  /** Active customer_user memberships. */
  userMembershipCount: number;
};

export type SetupMainStepState = {
  id: SetupMainStepId;
  title: string;
  purpose: string;
  progressPercent: number;
  status: SetupMainStepUiStatus;
  active: boolean;
  locked: boolean;
  subTasks: SetupSubTask[];
  statusSentence: string;
  href: string;
};

export type SetupOverview = {
  projectKey: string;
  steps: SetupMainStepState[];
  doneCount: number;
  totalCount: number;
  overallPercent: number;
  overallSentence: string;
  nextStepId: SetupMainStepId | null;
  localDataError: string | null;
};

function zoneExists(projectKey: string, zone: DataZone): boolean {
  try {
    const abs = resolveProjectZonePath(projectKey, zone);
    return existsSync(abs) && statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function projectRootExists(projectKey: string): boolean {
  try {
    const key = assertProjectKey(projectKey);
    const abs = resolveLocalPath(key);
    return existsSync(abs) && statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function dirHasAnyFile(abs: string, depth = 0): boolean {
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return false;
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const child = path.join(abs, name);
    try {
      const st = statSync(child);
      if (st.isFile() && st.size > 0) return true;
      if (st.isDirectory() && depth < 3 && dirHasAnyFile(child, depth + 1)) {
        return true;
      }
    } catch {
      /* skip */
    }
  }
  return false;
}

function rawHasContent(projectKey: string): boolean {
  try {
    return dirHasAnyFile(resolveProjectZonePath(projectKey, "raw"));
  } catch {
    return false;
  }
}

function hybridIndexPresent(projectKey: string): boolean {
  try {
    const indexes = resolveProjectZonePath(projectKey, "indexes");
    if (!existsSync(indexes)) return false;
    const candidates = [
      path.join(indexes, "hybrid-search-index.json"),
      path.join(indexes, "search", "hybrid-search-index.json"),
      path.join(indexes, "control-tables", "hybrid-search-index.json"),
    ];
    if (candidates.some((p) => existsSync(p) && statSync(p).isFile())) {
      return true;
    }
    return dirHasAnyFile(indexes);
  } catch {
    return false;
  }
}

function ctStatus(
  state: ControlTablesFahrplanState | null,
  id: FahrplanStepId,
): FahrplanStepStatus {
  return state?.steps[id]?.status ?? "not_available";
}

function fromCt(
  status: FahrplanStepStatus,
  locked: boolean,
): SetupSubTaskStatus {
  if (locked) return "locked";
  if (status === "success") return "done";
  if (status === "failed") return "error";
  if (status === "running") return "in_progress";
  if (status === "ready") return "open";
  return "open";
}

function fromPoint(status: PointStatus, locked: boolean): SetupSubTaskStatus {
  if (locked) return "locked";
  if (status === "done") return "done";
  if (status === "error") return "error";
  if (status === "in_progress") return "in_progress";
  if (status === "locked") return "locked";
  return "open";
}

function boolTask(
  ok: boolean,
  locked: boolean,
  err = false,
): SetupSubTaskStatus {
  if (locked) return "locked";
  if (err) return "error";
  return ok ? "done" : "open";
}

function progressFromSubTasks(subTasks: SetupSubTask[]): number {
  if (subTasks.length === 0) return 0;
  const done = subTasks.filter((t) => t.status === "done").length;
  return Math.round((done / subTasks.length) * 100);
}

function statusFromProgress(
  progress: number,
  locked: boolean,
  hasError: boolean,
): SetupMainStepUiStatus {
  if (locked) return "locked";
  if (progress >= 100) return "done";
  if (hasError) return "error";
  if (progress > 0) return "in_progress";
  return "ready";
}

function sentenceFor(
  status: SetupMainStepUiStatus,
  progress: number,
  done: number,
  total: number,
): string {
  switch (status) {
    case "locked":
      return "Gesperrt — vorheriger Schritt muss 100 % erreichen";
    case "done":
      return "Erledigt";
    case "error":
      return `Fehler — ${done}/${total} Teilaufgaben ok (${progress} %)`;
    case "in_progress":
      return `In Arbeit — ${done}/${total} Teilaufgaben (${progress} %)`;
    case "ready":
    default:
      return `Bereit — noch nicht gestartet (0/${total})`;
  }
}

function buildSubTasks(
  stepId: SetupMainStepId,
  locked: boolean,
  ctx: ProjectSetupContext,
  ct: ControlTablesFahrplanState | null,
  localOk: boolean,
  groups: ExportGroupsOverview | null,
  datenbasis: DatenbasisOverview | null,
  stage2Done: boolean,
  stage2FoldersOk: boolean,
): SetupSubTask[] {
  const meta = SETUP_MAIN_STEP_META[stepId];

  const map = (id: string, status: SetupSubTaskStatus, detail?: string): SetupSubTask => {
    const def = meta.subTaskDefs.find((d) => d.id === id)!;
    return { id, label: def.label, status, detail };
  };

  switch (stepId) {
    case 1: {
      const projectOk = Boolean(ctx.customerId);
      const customerOk = Boolean(
        ctx.customerName?.trim() && ctx.customerSlug?.trim(),
      );
      const goalOk = ctx.hasGoals || Boolean(ctx.productModule?.trim());
      const baseOk =
        projectOk &&
        customerOk &&
        Boolean(ctx.customerStatus) &&
        Boolean(ctx.productModule?.trim());
      return [
        map("project_created", boolTask(projectOk, locked)),
        map("customer_set", boolTask(customerOk, locked)),
        map(
          "agent_goal",
          boolTask(goalOk, locked),
          goalOk
            ? undefined
            : "Noch keine Ziele / kein Modul gesetzt",
        ),
        map("base_saved", boolTask(baseOk, locked)),
      ];
    }
    case 2: {
      if (!localOk) {
        return meta.subTaskDefs.map((d) =>
          map(d.id, locked ? "locked" : "error", "LOCAL_DATA_ROOT nicht verfügbar"),
        );
      }
      return [
        map(
          "folders_ok",
          boolTask(stage2FoldersOk, locked, !stage2FoldersOk && localOk),
          stage2FoldersOk
            ? undefined
            : "Ordner unter LOCAL_DATA_ROOT anlegen",
        ),
        map(
          "manual_complete",
          boolTask(stage2Done, locked),
          stage2Done
            ? undefined
            : "Nach Ordnerprüfung manuell abschließen",
        ),
      ];
    }
    case 3: {
      const classes = datenbasis?.types.find((t) => t.id === "classes");
      const programs = datenbasis?.types.find((t) => t.id === "programs");
      const classesDone = classes?.overall === "approved";
      const programsReady =
        Boolean(programs?.unlocked) && programs?.implementation === "prepared";
      return [
        map(
          "classes",
          locked
            ? "locked"
            : classesDone
              ? "done"
              : classes?.overall === "failed"
                ? "error"
                : classes?.overall === "in_progress" ||
                    classes?.overall === "awaiting_approval"
                  ? "in_progress"
                  : "open",
          classes?.nextActionLabel,
        ),
        map(
          "programs",
          locked ? "locked" : programsReady ? "open" : "locked",
          programsReady
            ? "Scaffold — Regeln noch unknown"
            : "Gesperrt bis Klassen freigegeben",
        ),
        map(
          "other_types",
          locked ? "locked" : "open",
          "Scaffold ohne erfundene Namensregeln",
        ),
      ];
    }
    case 4: {
      const zy = groups?.groups.find((g) => g.id === "zy-tables");
      const stages = zy?.validation.stages;
      const vLocked = locked || Boolean(zy?.validation.locked);
      return [
        map(
          "source_recognized",
          vLocked
            ? "locked"
            : fromPoint(
                stages?.find((s) => s.id === "source_recognized")?.status ??
                  fromCt(ctStatus(ct, 1), locked),
                vLocked,
              ),
        ),
        map(
          "raw_checked",
          vLocked
            ? "locked"
            : fromPoint(
                stages?.find((s) => s.id === "raw_checked")?.status ??
                  fromCt(ctStatus(ct, 2), locked),
                vLocked,
              ),
        ),
        map(
          "data_converted",
          vLocked
            ? "locked"
            : fromPoint(
                stages?.find((s) => s.id === "data_converted")?.status ??
                  fromCt(ctStatus(ct, 3), locked),
                vLocked,
              ),
        ),
        map(
          "canonical_checked",
          vLocked
            ? "locked"
            : fromPoint(
                stages?.find((s) => s.id === "canonical_checked")?.status ??
                  fromCt(ctStatus(ct, 4), locked),
                vLocked,
              ),
        ),
      ];
    }
    case 5: {
      const zy = groups?.groups.find((g) => g.id === "zy-tables");
      const fLocked = locked || Boolean(zy?.feintuning.locked);
      const stages = zy?.feintuning.stages ?? [];
      const knowledge = stages.find((s) => s.id === "knowledge_build");
      const indexOk =
        stages.find((s) => s.id === "index_update")?.status === "done" &&
        stages.find((s) => s.id === "direct_search")?.status === "done";
      const deepPlaus =
        stages.find((s) => s.id === "deep_search")?.status === "done" &&
        stages.find((s) => s.id === "plausibilize")?.status === "done";
      return [
        map(
          "knowledge_build",
          fLocked
            ? "locked"
            : fromPoint(knowledge?.status ?? "open", fLocked),
        ),
        map(
          "index_search",
          fLocked ? "locked" : boolTask(indexOk, fLocked),
          indexOk ? undefined : "Index + Direct-Suche",
        ),
        map(
          "deep_plaus",
          fLocked ? "locked" : boolTask(deepPlaus, fLocked),
          deepPlaus ? undefined : "KI-Suche + Plausibilität",
        ),
      ];
    }
    case 6: {
      const appReady = Boolean(ctx.customerId);
      const viewsOk = ctx.membershipCount > 0;
      // Honest: we don't invent a “training doc” — only mark done when
      // prior setup is complete enough that standard use is reachable.
      const priorReady = localOk && hybridIndexPresent(ctx.projectKey);
      const standardUse = priorReady;
      const golive =
        appReady && viewsOk && priorReady && ctx.userMembershipCount > 0;
      return [
        map("app_ready", boolTask(appReady, locked)),
        map(
          "views_checked",
          boolTask(viewsOk, locked),
          viewsOk ? undefined : "Noch keine aktiven Mitgliedschaften",
        ),
        map(
          "standard_use",
          boolTask(standardUse, locked),
          standardUse
            ? undefined
            : "Index/Wissen noch nicht nutzbar — Standardnutzung offen",
        ),
        map(
          "golive",
          boolTask(golive, locked),
          golive
            ? undefined
            : "Go-Live braucht Index und mindestens einen Anwender",
        ),
      ];
    }
  }
}

function customerQuery(
  customerId: string | null | undefined,
): string {
  if (!customerId) return "";
  return `?customer=${encodeURIComponent(customerId)}`;
}

/**
 * Compute the 6-step setup overview from project DB fields + LOCAL_DATA_ROOT
 * (+ Datenbasis for step 3, export-group / CT fahrplan for steps 4–5).
 * No parallel PM checklist DB.
 */
export function computeSetupOverview(
  ctx: ProjectSetupContext,
): SetupOverview {
  let ct: ControlTablesFahrplanState | null = null;
  let localDataError: string | null = null;
  let localOk = false;
  let groups: ExportGroupsOverview | null = null;
  let datenbasis: DatenbasisOverview | null = null;
  let stage2Done = false;
  let stage2FoldersOk = false;

  try {
    getLocalDataRoot();
    localOk = true;
    const stage2 = reconcileSetupStage2(ctx.projectKey);
    stage2FoldersOk = stage2.folders_ok;
    stage2Done = isStage2Done(stage2);
    ct = reconcileControlTablesFahrplanFromDisk(ctx.projectKey);
    groups = computeExportGroupsOverview({
      projectKey: ctx.projectKey,
      customerId: ctx.customerId,
    });
    datenbasis = computeDatenbasisOverview({
      projectKey: ctx.projectKey,
      customerId: ctx.customerId,
    });
    if (groups.localDataError) localDataError = groups.localDataError;
    if (datenbasis.localDataError) localDataError = datenbasis.localDataError;
  } catch (error) {
    localDataError =
      error instanceof Error
        ? error.message
        : "Lokale Daten nicht verfügbar (LOCAL_DATA_ROOT)";
  }

  const steps: SetupMainStepState[] = [];
  let previousDone = true;

  for (const id of SETUP_MAIN_STEP_IDS) {
    const meta = SETUP_MAIN_STEP_META[id];
    const locked: boolean = id === 1 ? false : !previousDone;
    const active = !locked;
    const subTasks = buildSubTasks(
      id,
      locked,
      ctx,
      ct,
      localOk,
      groups,
      datenbasis,
      stage2Done,
      stage2FoldersOk,
    );

    let progressPercent: number = locked ? 0 : progressFromSubTasks(subTasks);
    // Area 3: Datenbasis (classes approved = done). Areas 4–5: export-groups.
    if (!locked) {
      if (id === 3 && datenbasis) {
        progressPercent = datenbasis.area3Done
          ? 100
          : datenbasis.progressPercent;
      } else if (groups) {
        if (id === 4) {
          progressPercent = groups.area4Done ? 100 : groups.area4Percent;
        } else if (id === 5) {
          progressPercent = groups.area5Done ? 100 : groups.area5Percent;
        }
      }
    }

    const hasError = !locked && subTasks.some((t) => t.status === "error");
    let status = statusFromProgress(progressPercent, locked, hasError);
    if (!locked) {
      if (id === 3 && datenbasis?.area3Done) status = "done";
      if (id === 2 && stage2Done) {
        status = "done";
        progressPercent = 100;
      }
      if (groups) {
        if (id === 4 && groups.area4Done) status = "done";
        if (id === 5 && groups.area5Done) status = "done";
      }
    }

    let done = subTasks.filter((t) => t.status === "done").length;
    let total = subTasks.length;
    if (!locked && id === 3 && datenbasis) {
      done = datenbasis.area3Done ? 1 : 0;
      total = 1;
    } else if (!locked && groups && (id === 4 || id === 5)) {
      const required = groups.groups.filter((g) => g.requiredForMainProgress);
      if (id === 4) {
        done = required.filter((g) => g.validation.fullyValidated).length;
        total = required.length;
      } else {
        done = required.filter((g) => g.feintuning.fullyTuned).length;
        total = required.length;
      }
    }
    const qs = customerQuery(ctx.customerId);

    steps.push({
      id,
      title: meta.title,
      purpose: meta.purpose,
      progressPercent: status === "done" ? 100 : progressPercent,
      status,
      active,
      locked,
      subTasks,
      statusSentence: sentenceFor(status, progressPercent, done, total),
      href: `/admin/steps/${id}${qs}`,
    });

    previousDone = status === "done";
  }

  const doneCount = steps.filter((s) => s.status === "done").length;
  const totalCount = steps.length;
  const overallPercent = Math.round(
    steps.reduce((sum, s) => sum + s.progressPercent, 0) / totalCount,
  );
  const next =
    steps.find((s) => s.active && s.status !== "done") ?? null;

  let overallSentence: string;
  if (doneCount === totalCount) {
    overallSentence = "Alle Hauptschritte erledigt";
  } else {
    overallSentence = `${doneCount}/${totalCount} Hauptschritten abgeschlossen`;
  }

  return {
    projectKey: ctx.projectKey,
    steps,
    doneCount,
    totalCount,
    overallPercent,
    overallSentence,
    nextStepId: next?.id ?? null,
    localDataError,
  };
}

export function parseSetupStepId(
  raw: string | undefined,
): SetupMainStepId | null {
  const n = Number(raw);
  if (SETUP_MAIN_STEP_IDS.includes(n as SetupMainStepId)) {
    return n as SetupMainStepId;
  }
  return null;
}

export function setupStepStatusLabel(status: SetupMainStepUiStatus): string {
  switch (status) {
    case "done":
      return "Erledigt";
    case "error":
      return "Fehler";
    case "in_progress":
      return "In Arbeit";
    case "ready":
      return "Bereit";
    case "locked":
    default:
      return "Gesperrt";
  }
}

export function setupSubTaskStatusLabel(status: SetupSubTaskStatus): string {
  switch (status) {
    case "done":
      return "Erledigt";
    case "error":
      return "Fehler";
    case "in_progress":
      return "Läuft";
    case "locked":
      return "Gesperrt";
    case "open":
    default:
      return "Offen";
  }
}

/** Map setup sub-task status onto CompactStatus button tones. */
export function subTaskToFahrplanTone(
  status: SetupSubTaskStatus,
): FahrplanStepStatus {
  switch (status) {
    case "done":
      return "success";
    case "error":
      return "failed";
    case "in_progress":
      return "running";
    case "locked":
      return "not_available";
    case "open":
    default:
      return "ready";
  }
}

export function mainStatusToFahrplanTone(
  status: SetupMainStepUiStatus,
): FahrplanStepStatus {
  switch (status) {
    case "done":
      return "success";
    case "error":
      return "failed";
    case "in_progress":
      return "running";
    case "locked":
      return "not_available";
    case "ready":
    default:
      return "ready";
  }
}

/** Expose zone list for diagnostics (unused in UI by default). */
export function listExpectedZones(): readonly DataZone[] {
  return DATA_ZONES;
}

export function allFahrplanStepsDone(
  ct: ControlTablesFahrplanState | null,
): boolean {
  if (!ct) return false;
  return FAHRPLAN_STEP_IDS.every((id) => ct.steps[id].status === "success");
}
