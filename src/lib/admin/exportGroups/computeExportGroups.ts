import { getLocalDataRoot } from "@/lib/localData/root";
import {
  reconcileControlTablesFahrplanFromDisk,
  verifyExistingKnowledge,
} from "@/lib/rebuild/controlTablesFahrplan";
import type {
  ControlTablesFahrplanState,
  FahrplanStepStatus,
} from "@/lib/rebuild/controlTablesFahrplanTypes";
import {
  exportGroupDetailHref,
  isExportGroupId,
  listExportGroupDefinitions,
} from "./definitions";
import {
  isOrgConfirmed,
  loadExportGroupsOrgState,
  type OrgPointKey,
} from "./orgState";
import { rawFolderHasFiles, splitRawTarget } from "./rawPresence";
import type {
  ExportGroupDefinition,
  ExportGroupId,
  ExportGroupState,
  ExportGroupsOrgState,
  ExportGroupsOverview,
  FeintuningStage,
  FlowPoint,
  PointStatus,
  ValidationStage,
} from "./types";

export type { ExportGroupsOverview, ExportGroupState };

function fromCt(status: FahrplanStepStatus, locked: boolean): PointStatus {
  if (locked) return "locked";
  if (status === "success") return "done";
  if (status === "failed") return "error";
  if (status === "running") return "in_progress";
  if (status === "not_available") return "locked";
  return "open";
}

function aggregateStatus(statuses: PointStatus[]): PointStatus {
  if (statuses.length === 0) return "open";
  if (statuses.every((s) => s === "done")) return "done";
  if (statuses.some((s) => s === "error")) return "error";
  if (statuses.some((s) => s === "in_progress")) return "in_progress";
  if (statuses.every((s) => s === "locked")) return "locked";
  if (statuses.some((s) => s === "done" || s === "open")) {
    if (statuses.some((s) => s === "done")) return "in_progress";
    return "open";
  }
  return "open";
}

function progressOf(statuses: PointStatus[]): number {
  if (statuses.length === 0) return 0;
  const countable = statuses.filter((s) => s !== "locked");
  const pool = countable.length > 0 ? countable : statuses;
  const done = pool.filter((s) => s === "done").length;
  return Math.round((done / pool.length) * 100);
}

function ctStatus(
  ct: ControlTablesFahrplanState | null,
  id: 1 | 2 | 3 | 4 | 5 | 6,
): FahrplanStepStatus {
  return ct?.steps[id]?.status ?? "not_available";
}

function anyRawPresent(
  projectKey: string,
  def: ExportGroupDefinition,
): boolean {
  return def.rawTargetPaths.some((p) =>
    rawFolderHasFiles(projectKey, splitRawTarget(p)),
  );
}

function zyDefsPresent(projectKey: string): boolean {
  return rawFolderHasFiles(projectKey, ["control-tables", "definitions"]);
}

function zyContentsPresent(projectKey: string): boolean {
  return rawFolderHasFiles(projectKey, ["control-tables", "contents"]);
}

function orgDone(
  org: ExportGroupsOrgState,
  groupId: ExportGroupDefinition["id"],
  key: OrgPointKey | string,
): boolean {
  return isOrgConfirmed(org, groupId, key);
}

function buildOperationalFlow(
  def: ExportGroupDefinition,
  org: ExportGroupsOrgState,
  techRecognized: boolean,
  techStatus: PointStatus,
  filesPresent: boolean,
): FlowPoint[] {
  const reportKnown = Boolean(def.sapReport && def.sapReport !== "—");
  const reportReady =
    reportKnown || orgDone(org, def.id, "report_ready");
  const sapPrepared = orgDone(org, def.id, "sap_prepared");
  const exportExecuted = orgDone(org, def.id, "export_executed");
  const filesPlaced =
    orgDone(org, def.id, "files_placed") ||
    orgDone(org, def.id, "definitions_filed") ||
    orgDone(org, def.id, "contents_filed") ||
    filesPresent;

  return [
    {
      id: "report_export_type",
      label: "Report + Exporttyp",
      kind: "info",
      status: reportReady ? "done" : "open",
      detail: `${def.sapReport} · ${def.exportType}`,
    },
    {
      id: "sap_prepared",
      label: "Ausführung in SAP vorbereiten",
      kind: "org",
      status: sapPrepared ? "done" : "open",
      confirmable: true,
      detail: sapPrepared ? "Manuell bestätigt" : "Organisatorisch bestätigen",
    },
    {
      id: "export_executed",
      label: "Export ausführen",
      kind: "org",
      status: exportExecuted ? "done" : "open",
      confirmable: true,
      detail: exportExecuted ? "Manuell bestätigt" : "Organisatorisch bestätigen",
    },
    {
      id: "files_placed",
      label: "Dateien in RAW ablegen",
      kind: "org",
      status: filesPlaced ? "done" : "open",
      confirmable: true,
      detail: filesPresent
        ? "Dateien unter erwarteten RAW-Pfaden gefunden"
        : filesPlaced
          ? "Manuell bestätigt"
          : `Ziel: ${def.rawTargetPaths.join(", ")}`,
    },
    {
      id: "sources_recognized",
      label: "App erkennt Dateien",
      kind: "tech",
      status: techStatus,
      detail: techRecognized
        ? "Technisch erkannt"
        : "Nur System — keine manuelle Erledigung",
    },
  ];
}

function buildZyRecognitionDetail(
  projectKey: string,
  org: ExportGroupsOrgState,
  ct: ControlTablesFahrplanState | null,
): FlowPoint[] {
  const s1 = ctStatus(ct, 1);
  const defs = zyDefsPresent(projectKey);
  const contents = zyContentsPresent(projectKey);
  const defsFiled =
    orgDone(org, "zy-tables", "definitions_filed") || defs;
  const contentsFiled =
    orgDone(org, "zy-tables", "contents_filed") || contents;
  const exportExecuted = orgDone(org, "zy-tables", "export_executed");

  return [
    {
      id: "report_ready",
      label: "Report vorhanden/transportiert",
      kind: "info",
      status: "done",
      detail: "Z_AI_REPOSITORY_EXPORT (bekannt)",
    },
    {
      id: "export_executed",
      label: "Export ausgeführt",
      kind: "org",
      status: exportExecuted ? "done" : "open",
      confirmable: true,
    },
    {
      id: "definitions_filed",
      label: "Definitionen abgelegt",
      kind: "org",
      status: defsFiled ? "done" : "open",
      confirmable: true,
      detail: defs
        ? "raw/control-tables/definitions/"
        : "Erwartet unter raw/control-tables/definitions/",
    },
    {
      id: "contents_filed",
      label: "Inhalte abgelegt",
      kind: "org",
      status: contentsFiled ? "done" : "open",
      confirmable: true,
      detail: contents
        ? "raw/control-tables/contents/"
        : "Erwartet unter raw/control-tables/contents/",
    },
    {
      id: "sources_recognized",
      label: "Quellen technisch erkannt",
      kind: "tech",
      status: fromCt(s1, false),
      detail:
        s1 === "success"
          ? "Control-Tables-Erkennung (Fahrplan Schritt 1)"
          : "Über bestehende Control-Tables-Erkennung — kein Parallel-Pipeline",
    },
  ];
}

function buildValidationStages(
  def: ExportGroupDefinition,
  locked: boolean,
  ct: ControlTablesFahrplanState | null,
  techRecognized: boolean,
): ValidationStage[] {
  if (locked) {
    return [
      {
        id: "source_recognized",
        label: "Quelle erkannt",
        status: "locked",
        detail: "Zuerst in Datenbasis vollständig erkennen",
      },
      {
        id: "raw_checked",
        label: "RAW geprüft",
        status: "locked",
      },
      {
        id: "data_converted",
        label: "Daten konvertiert",
        status: "locked",
      },
      {
        id: "canonical_checked",
        label: "Canonical geprüft",
        status: "locked",
      },
    ];
  }

  if (def.pipeline === "control-tables") {
    return [
      {
        id: "source_recognized",
        label: "Quelle erkannt",
        status: fromCt(ctStatus(ct, 1), false),
        detail: "Control-Tables Fahrplan Schritt 1",
      },
      {
        id: "raw_checked",
        label: "RAW geprüft",
        status: fromCt(ctStatus(ct, 2), false),
        detail: "Control-Tables Fahrplan Schritt 2",
      },
      {
        id: "data_converted",
        label: "Daten konvertiert",
        status: fromCt(ctStatus(ct, 3), false),
        detail: "Control-Tables Fahrplan Schritt 3",
      },
      {
        id: "canonical_checked",
        label: "Canonical geprüft",
        status: fromCt(ctStatus(ct, 4), false),
        detail: "Control-Tables Fahrplan Schritt 4",
      },
    ];
  }

  // Prepared groups: recognition-only stub; no invented convert success.
  return [
    {
      id: "source_recognized",
      label: "Quelle erkannt",
      status: techRecognized ? "done" : "open",
      detail: techRecognized
        ? "Dateien unter erwarteten RAW-Pfaden"
        : "Rahmen — Erkennung über Dateipräsenz",
    },
    {
      id: "raw_checked",
      label: "RAW geprüft",
      status: "open",
      detail: "Noch nicht angebunden (Rahmen)",
    },
    {
      id: "data_converted",
      label: "Daten konvertiert",
      status: "open",
      detail: "Noch keine Konvertierungslogik",
    },
    {
      id: "canonical_checked",
      label: "Canonical geprüft",
      status: "open",
      detail: "Noch nicht angebunden (Rahmen)",
    },
  ];
}

function buildFeintuningStages(
  def: ExportGroupDefinition,
  locked: boolean,
  ct: ControlTablesFahrplanState | null,
  projectKey: string,
): FeintuningStage[] {
  if (locked) {
    return [
      {
        id: "knowledge_build",
        label: "Wissensbestand aufbauen",
        status: "locked",
        detail: "Zuerst Validierung abschließen",
      },
      {
        id: "search_documents",
        label: "SearchDocuments",
        status: "locked",
      },
      {
        id: "embeddings",
        label: "Embeddings",
        status: "locked",
      },
      {
        id: "index_update",
        label: "Index aktualisieren",
        status: "locked",
      },
      {
        id: "direct_search",
        label: "Direct-Suche testen",
        status: "locked",
      },
      {
        id: "deep_search",
        label: "KI-Tiefensuche testen",
        status: "locked",
      },
      {
        id: "plausibilize",
        label: "Ergebnis plausibilisieren",
        status: "locked",
      },
    ];
  }

  if (def.pipeline !== "control-tables") {
    return [
      {
        id: "knowledge_build",
        label: "Wissensbestand aufbauen",
        status: "open",
        detail: "Rahmen — Rebuild noch nicht angebunden",
      },
      {
        id: "search_documents",
        label: "SearchDocuments",
        status: "open",
        detail: "Rahmen",
      },
      {
        id: "embeddings",
        label: "Embeddings",
        status: "open",
        detail: "Rahmen",
      },
      {
        id: "index_update",
        label: "Index aktualisieren",
        status: "open",
        detail: "Rahmen",
      },
      {
        id: "direct_search",
        label: "Direct-Suche testen",
        status: "open",
        detail: "Rahmen",
      },
      {
        id: "deep_search",
        label: "KI-Tiefensuche testen",
        status: "open",
        detail: "Rahmen",
      },
      {
        id: "plausibilize",
        label: "Ergebnis plausibilisieren",
        status: "open",
        detail: "Rahmen",
      },
    ];
  }

  let evidence: ReturnType<typeof verifyExistingKnowledge> | null = null;
  try {
    evidence = verifyExistingKnowledge(projectKey);
  } catch {
    evidence = null;
  }

  const s5 = ctStatus(ct, 5);
  const s6 = ctStatus(ct, 6);
  const sub = ct?.steps[5]?.result?.substeps ?? [];
  const subOk = (key: string) => sub.find((x) => x.key === key)?.ok === true;

  const knowledgeOk =
    s5 === "success" || Boolean(evidence?.ok && evidence.canonical_ok);
  const searchDocsOk =
    subOk("searchdocs") ||
    Boolean(evidence && evidence.search_documents_count > 0);
  const embeddingsOk =
    subOk("embeddings") || Boolean(evidence && evidence.embeddings_count > 0);
  const indexOk =
    subOk("search_index") ||
    Boolean(
      evidence &&
        evidence.exact_index_ok &&
        evidence.fulltext_index_ok &&
        evidence.metadata_index_ok,
    );

  const samples = ct?.steps[6]?.result?.samples ?? [];
  const directOk = s6 === "success";
  // No separate deep-search smoke yet — treat Ask-ready knowledge + smoke as gate.
  const deepOk = s6 === "success" && knowledgeOk;
  const plausOk =
    s6 === "success" &&
    (samples.length === 0 || samples.every((s) => s.ok));

  return [
    {
      id: "knowledge_build",
      label: "Wissensbestand aufbauen",
      status: knowledgeOk
        ? "done"
        : fromCt(s5, false) === "error"
          ? "error"
          : fromCt(s5, false),
      detail: "Control-Tables Fahrplan Schritt 5 / Rebuild",
    },
    {
      id: "search_documents",
      label: "SearchDocuments",
      status: searchDocsOk ? "done" : knowledgeOk ? "open" : "open",
      detail: evidence
        ? `${evidence.search_documents_count} Dokumente`
        : "Aus Rebuild-Evidenz",
    },
    {
      id: "embeddings",
      label: "Embeddings",
      status: embeddingsOk ? "done" : "open",
      detail: evidence ? `${evidence.embeddings_count}` : undefined,
    },
    {
      id: "index_update",
      label: "Index aktualisieren",
      status: indexOk ? "done" : "open",
      detail: "Hybrid-/Tabellenindex",
    },
    {
      id: "direct_search",
      label: "Direct-Suche testen",
      status: fromCt(s6, false),
      detail: "Smoke Direct-RAG (Fahrplan Schritt 6)",
    },
    {
      id: "deep_search",
      label: "KI-Tiefensuche testen",
      status: deepOk ? "done" : directOk ? "open" : fromCt(s6, false),
      detail: deepOk
        ? "Wissen nutzbar (Ask / bestehende Suche)"
        : "Über bestehende Ask-/RAG-Pipeline — kein neuer Algorithmus",
    },
    {
      id: "plausibilize",
      label: "Ergebnis plausibilisieren",
      status: plausOk
        ? "done"
        : s6 === "failed"
          ? "error"
          : "open",
      detail:
        samples.length > 0
          ? `${samples.filter((s) => s.ok).length}/${samples.length} Smoke ok`
          : "Smoke-Proben der Suche",
    },
  ];
}

function nextActionFor(group: {
  fullyRecognized: boolean;
  validation: { locked: boolean; fullyValidated: boolean; stages: ValidationStage[] };
  feintuning: { locked: boolean; fullyTuned: boolean; stages: FeintuningStage[] };
  operationalFlow: FlowPoint[];
  pipeline: ExportGroupDefinition["pipeline"];
}): string {
  if (!group.fullyRecognized) {
    const openOrg = group.operationalFlow.find(
      (p) => p.kind === "org" && p.status !== "done",
    );
    if (openOrg) return `Organisatorisch: ${openOrg.label}`;
    return "Technische Erkennung der Quelldateien";
  }
  if (!group.validation.locked && !group.validation.fullyValidated) {
    const next = group.validation.stages.find((s) => s.status !== "done");
    return next ? `Validierung: ${next.label}` : "Validierung fortsetzen";
  }
  if (!group.feintuning.locked && !group.feintuning.fullyTuned) {
    const next = group.feintuning.stages.find((s) => s.status !== "done");
    return next ? `Feintuning: ${next.label}` : "Feintuning fortsetzen";
  }
  if (group.pipeline === "prepared") {
    return "Rahmen vorbereitet — Konvertierung folgt später";
  }
  return "Gruppe abgeschlossen";
}

function computeGroupState(params: {
  def: ExportGroupDefinition;
  projectKey: string;
  customerId: string | null;
  org: ExportGroupsOrgState;
  ct: ControlTablesFahrplanState | null;
  localOk: boolean;
}): ExportGroupState {
  const { def, projectKey, customerId, org, ct, localOk } = params;
  const filesPresent = localOk && anyRawPresent(projectKey, def);

  let techRecognized = false;
  let techStatus: PointStatus = localOk ? "open" : "error";

  if (def.pipeline === "control-tables") {
    const s1 = ctStatus(ct, 1);
    techRecognized = s1 === "success";
    techStatus = localOk ? fromCt(s1, false) : "error";
  } else {
    techRecognized = filesPresent;
    techStatus = !localOk ? "error" : filesPresent ? "done" : "open";
  }

  const operationalFlow = buildOperationalFlow(
    def,
    org,
    techRecognized,
    techStatus,
    filesPresent,
  );
  const recognitionDetail =
    def.id === "zy-tables" && localOk
      ? buildZyRecognitionDetail(projectKey, org, ct)
      : operationalFlow.filter((p) => p.id !== "report_export_type");

  const orgStatuses = operationalFlow
    .filter((p) => p.kind === "org")
    .map((p) => p.status);
  const organizationalStatus = aggregateStatus(orgStatuses);
  const technicalStatus = techStatus;

  const flowStatuses = operationalFlow.map((p) => p.status);
  const progressPercent = progressOf(flowStatuses);
  const fullyRecognized = techRecognized;

  const validationLocked = !fullyRecognized;
  const validationStages = buildValidationStages(
    def,
    validationLocked,
    ct,
    techRecognized,
  );
  const validationProgress = validationLocked
    ? 0
    : progressOf(validationStages.map((s) => s.status));
  const fullyValidated =
    !validationLocked &&
    validationStages.every((s) => s.status === "done");

  const feintuningLocked = !fullyValidated;
  const feintuningStages = buildFeintuningStages(
    def,
    feintuningLocked,
    ct,
    projectKey,
  );
  const feintuningProgress = feintuningLocked
    ? 0
    : progressOf(feintuningStages.map((s) => s.status));
  const fullyTuned =
    !feintuningLocked && feintuningStages.every((s) => s.status === "done");

  const partial: ExportGroupState = {
    id: def.id,
    title: def.title,
    description: def.description,
    sapReport: def.sapReport,
    exportType: def.exportType,
    expectedSourceFiles: def.expectedSourceFiles,
    rawTargetPaths: def.rawTargetPaths,
    organizationalStatus,
    technicalStatus,
    progressPercent: fullyRecognized ? 100 : progressPercent,
    dependencies: def.dependencies,
    detailPageLink: exportGroupDetailHref(3, def.id, customerId),
    requiredForMainProgress: def.requiredForMainProgress,
    pipeline: def.pipeline,
    preparedSubtypes: def.preparedSubtypes,
    fullyRecognized,
    operationalFlow,
    recognitionDetail,
    nextAction: "",
    validation: {
      locked: validationLocked,
      stages: validationStages,
      progressPercent: fullyValidated ? 100 : validationProgress,
      fullyValidated,
    },
    feintuning: {
      locked: feintuningLocked,
      stages: feintuningStages,
      progressPercent: fullyTuned ? 100 : feintuningProgress,
      fullyTuned,
    },
  };
  partial.nextAction = nextActionFor(partial);
  return partial;
}

/**
 * Compute export-group status for Areas 3–5.
 * Z-/Y reuses Control-Tables Fahrplan — no parallel pipeline.
 */
export function computeExportGroupsOverview(params: {
  projectKey: string;
  customerId?: string | null;
}): ExportGroupsOverview {
  const projectKey = params.projectKey.trim() || "P01";
  const customerId = params.customerId ?? null;

  let ct: ControlTablesFahrplanState | null = null;
  let localDataError: string | null = null;
  let localOk = false;
  let org = createOrgFallback(projectKey);

  try {
    getLocalDataRoot();
    localOk = true;
    org = loadExportGroupsOrgState(projectKey);
    ct = reconcileControlTablesFahrplanFromDisk(projectKey);
  } catch (error) {
    localDataError =
      error instanceof Error
        ? error.message
        : "Lokale Daten nicht verfügbar (LOCAL_DATA_ROOT)";
  }

  const groups = listExportGroupDefinitions().map((def) =>
    computeGroupState({ def, projectKey, customerId, org, ct, localOk }),
  );

  const required = groups.filter((g) => g.requiredForMainProgress);
  const pool = required.length > 0 ? required : groups;

  const area3Percent = average(pool.map((g) => g.progressPercent));
  const area4Percent = average(pool.map((g) => g.validation.progressPercent));
  const area5Percent = average(pool.map((g) => g.feintuning.progressPercent));

  return {
    projectKey,
    groups,
    area3Percent,
    area4Percent,
    area5Percent,
    area3Done: pool.every((g) => g.fullyRecognized),
    area4Done: pool.every((g) => g.validation.fullyValidated),
    area5Done: pool.every((g) => g.feintuning.fullyTuned),
    localDataError,
  };
}

function createOrgFallback(projectKey: string): ExportGroupsOrgState {
  return {
    schema_version: 1,
    project: projectKey,
    updated_at: new Date().toISOString(),
    groups: {},
  };
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

export function parseExportGroupId(
  raw: string | undefined,
): ExportGroupId | null {
  if (isExportGroupId(raw)) return raw;
  return null;
}
