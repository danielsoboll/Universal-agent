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
    purpose: "Lokale Ordnerstruktur und Daten-Zonen prüfen",
    subTaskDefs: [
      { id: "folder_linked", label: "Ordnerstruktur verknüpft" },
      { id: "input_present", label: "Eingabe vorhanden" },
      { id: "raw_present", label: "RAW vorhanden" },
      { id: "zones_present", label: "Canonical / Embeddings / Indexes / Logs vorhanden" },
      { id: "structure_ok", label: "Agent-Struktur validiert" },
    ],
  },
  3: {
    id: 3,
    title: "Exporte Teil 1",
    purpose: "Erste Exportdateien finden und Import-Basis prüfen",
    subTaskDefs: [
      { id: "export_files", label: "Erste Exportdateien vorhanden" },
      { id: "source_paths", label: "Quellpfade erkannt" },
      { id: "file_types", label: "Dateitypen geprüft" },
      { id: "import_base", label: "Import-Basis vollständig" },
    ],
  },
  4: {
    id: 4,
    title: "Validierung",
    purpose: "Quellen erkennen, RAW prüfen, konvertieren und Ergebnis prüfen",
    subTaskDefs: [
      { id: "source_recognized", label: "Quelldatei erkannt" },
      { id: "raw_checked", label: "RAW geprüft" },
      { id: "data_converted", label: "Daten konvertiert" },
      { id: "converted_checked", label: "Konvertierte Daten geprüft" },
    ],
  },
  5: {
    id: 5,
    title: "Export Teil 2 und Feintuning",
    purpose: "Wissensbestand, Index und Suche absichern",
    subTaskDefs: [
      { id: "knowledge_updated", label: "Wissensbestand aktualisiert" },
      { id: "index_built", label: "Index aufgebaut" },
      { id: "search_tested", label: "Suche getestet" },
      { id: "answers_ok", label: "Antworten plausibilisiert" },
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
      const folder = projectRootExists(ctx.projectKey);
      const raw = zoneExists(ctx.projectKey, "raw");
      const input = raw && rawHasContent(ctx.projectKey);
      const writableOk = (["canonical", "embeddings", "indexes", "logs"] as const).every(
        (z) => zoneExists(ctx.projectKey, z),
      );
      const structureOk = folder && raw && writableOk;
      return [
        map(
          "folder_linked",
          boolTask(folder, locked, !folder && localOk),
          folder ? undefined : `Ordner ${ctx.projectKey} fehlt unter LOCAL_DATA_ROOT`,
        ),
        map(
          "input_present",
          boolTask(input, locked),
          input ? undefined : "Noch keine Dateien unter raw/",
        ),
        map("raw_present", boolTask(raw, locked)),
        map("zones_present", boolTask(writableOk, locked)),
        map("structure_ok", boolTask(structureOk, locked)),
      ];
    }
    case 3: {
      if (!localOk) {
        return meta.subTaskDefs.map((d) =>
          map(d.id, locked ? "locked" : "error", "LOCAL_DATA_ROOT nicht verfügbar"),
        );
      }
      const exportFiles = rawHasContent(ctx.projectKey);
      const s1 = ctStatus(ct, 1);
      const s2 = ctStatus(ct, 2);
      const pathsOk =
        s1 === "success" || (ct?.steps[1]?.result?.files?.length ?? 0) > 0;
      const importBase = s1 === "success" && s2 === "success";
      return [
        map("export_files", boolTask(exportFiles, locked)),
        map(
          "source_paths",
          locked
            ? "locked"
            : pathsOk
              ? "done"
              : fromCt(s1, locked),
        ),
        map("file_types", fromCt(s2, locked)),
        map("import_base", boolTask(importBase, locked)),
      ];
    }
    case 4: {
      return [
        map("source_recognized", fromCt(ctStatus(ct, 1), locked)),
        map("raw_checked", fromCt(ctStatus(ct, 2), locked)),
        map("data_converted", fromCt(ctStatus(ct, 3), locked)),
        map("converted_checked", fromCt(ctStatus(ct, 4), locked)),
      ];
    }
    case 5: {
      const s5 = ctStatus(ct, 5);
      const s6 = ctStatus(ct, 6);
      const indexOk =
        hybridIndexPresent(ctx.projectKey) || s5 === "success";
      const samples = ct?.steps[6]?.result?.samples ?? [];
      const answersOk =
        s6 === "success" &&
        (samples.length === 0 || samples.every((s) => s.ok));
      return [
        map("knowledge_updated", fromCt(s5, locked)),
        map("index_built", boolTask(indexOk, locked, s5 === "failed")),
        map("search_tested", fromCt(s6, locked)),
        map(
          "answers_ok",
          locked
            ? "locked"
            : answersOk
              ? "done"
              : s6 === "failed"
                ? "error"
                : "open",
          answersOk
            ? undefined
            : "Smoke-Tests der Suche noch nicht erfolgreich",
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
 * (+ control-tables fahrplan for steps 3–5). No parallel PM checklist DB.
 */
export function computeSetupOverview(
  ctx: ProjectSetupContext,
): SetupOverview {
  let ct: ControlTablesFahrplanState | null = null;
  let localDataError: string | null = null;
  let localOk = false;

  try {
    getLocalDataRoot();
    localOk = true;
    ct = reconcileControlTablesFahrplanFromDisk(ctx.projectKey);
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
    const subTasks = buildSubTasks(id, locked, ctx, ct, localOk);
    const progressPercent: number = locked
      ? 0
      : progressFromSubTasks(subTasks);
    const hasError = !locked && subTasks.some((t) => t.status === "error");
    const status = statusFromProgress(progressPercent, locked, hasError);
    const done = subTasks.filter((t) => t.status === "done").length;
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
      statusSentence: sentenceFor(
        status,
        progressPercent,
        done,
        subTasks.length,
      ),
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
