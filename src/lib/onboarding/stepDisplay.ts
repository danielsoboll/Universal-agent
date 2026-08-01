/**
 * UI-only presentation helpers for the Admin Fahrplan.
 * Does not change workflow status computation or persisted values.
 */

export type StepDisplayStatus =
  | "ready"
  | "in_progress"
  | "waiting_for_prereq"
  | "waiting_for_file"
  | "waiting_for_approval"
  | "checking"
  | "blocked"
  | "completed"
  | "skipped"
  | "not_ready";

export type ParsedInfoText = {
  was: string | null;
  warum: string | null;
  ergebnis: string | null;
  fertigWenn: string | null;
  remainder: string | null;
};

export type FahrplanStepLike = {
  status: string;
  completed?: boolean | null;
  required?: boolean | null;
  error_summary?: string | null;
  result_summary?: string | null;
  completion_type?: string | null;
  prerequisites?: string[] | null;
  short_description?: string | null;
  info_text?: string | null;
  phase_key?: string | null;
  title?: string | null;
  detailed_instructions?: string | null;
  responsible_role?: string | null;
  adapter_key?: string | null;
  pipeline_step_key?: string | null;
  step_key?: string | null;
};

export const STEP_DISPLAY_LABELS: Record<StepDisplayStatus, string> = {
  ready: "Bereit",
  in_progress: "In Arbeit",
  waiting_for_prereq: "Wartet auf Voraussetzung",
  waiting_for_file: "Wartet auf Datei",
  waiting_for_approval: "Wartet auf Freigabe",
  checking: "Prüfung läuft",
  blocked: "Blockiert",
  completed: "Abgeschlossen",
  skipped: "Übersprungen",
  not_ready: "Noch nicht bereit",
};

/** Tailwind / semantic classes — only hard blockers use danger. */
export const STEP_DISPLAY_BADGE_CLASS: Record<StepDisplayStatus, string> = {
  ready:
    "bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[color-mix(in_srgb,var(--accent)_25%,transparent)]",
  in_progress:
    "bg-[var(--accent-soft)] text-[var(--foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_20%,transparent)]",
  waiting_for_prereq:
    "bg-[var(--surface-raised)] text-[var(--muted)] ring-1 ring-[var(--border)]",
  waiting_for_file:
    "bg-[var(--surface-raised)] text-[var(--muted)] ring-1 ring-[var(--border)]",
  waiting_for_approval:
    "bg-[var(--surface-raised)] text-[var(--muted)] ring-1 ring-[var(--border)]",
  checking:
    "bg-[var(--accent-soft)] text-[var(--foreground)] ring-1 ring-[color-mix(in_srgb,var(--accent)_20%,transparent)]",
  blocked: "bg-[var(--danger-soft)] text-[var(--danger)]",
  completed:
    "bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[color-mix(in_srgb,var(--accent)_20%,transparent)]",
  skipped: "bg-[var(--surface-raised)] text-[var(--muted)]",
  not_ready: "bg-[var(--surface-raised)] text-[var(--muted)]",
};

const SHORT_DESCRIPTION_SOFTEN: Array<[RegExp, string]> = [
  [
    /^Exportmechanismus im Quellsystem anlegen oder prüfen\.?$/i,
    "Prüfen Sie, ob der Exportreport im SAP-System vorhanden und ausführbar ist",
  ],
  [
    /^Freigabe für Exporte und Uploads sicherstellen\.?$/i,
    "Stellen Sie sicher, dass Exporte und Uploads freigegeben sind",
  ],
  [
    /^Gewählte Ziele und Adapter gegenprüfen\.?$/i,
    "Prüfen Sie die gewählten Ziele und Quellen noch einmal gegen den Scope",
  ],
  [
    /^System-ID, Mandant und Umgebung erfassen\.?$/i,
    "Erfassen Sie System-ID, Mandant und Umgebung",
  ],
  [
    /^ABAP-Repository gemäß Filter exportieren\.?$/i,
    "Exportieren Sie das ABAP-Repository gemäß dem vereinbarten Filter",
  ],
  [
    /^Tabellenliste ohne Zeileninhalt erzeugen\.?$/i,
    "Erzeugen Sie eine Tabellenliste ohne Zeileninhalte",
  ],
  [
    /^Freigegebene Tabelleninhalte exportieren\.?$/i,
    "Exportieren Sie die freigegebenen Tabelleninhalte",
  ],
  [
    /^Verantwortlichkeiten und Scope-Rahmen klären\.?$/i,
    "Klären Sie Verantwortlichkeiten und den Scope-Rahmen",
  ],
];

const RESULT_SOFTEN: Array<[RegExp, string]> = [
  [/status\s*validated/i, "Die Datei wurde erfolgreich geprüft"],
  [/validated/i, "Erfolgreich geprüft"],
  [/ok\b/i, "In Ordnung"],
];

function capitalizeSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toLocaleUpperCase("de-DE") + trimmed.slice(1);
}

export function parseInfoText(raw: string | null | undefined): ParsedInfoText {
  const text = (raw ?? "").trim();
  if (!text) {
    return { was: null, warum: null, ergebnis: null, fertigWenn: null, remainder: null };
  }

  const patterns: Array<[keyof Omit<ParsedInfoText, "remainder">, RegExp]> = [
    ["was", /Was:\s*/i],
    ["warum", /Warum:\s*/i],
    ["ergebnis", /Ergebnis:\s*/i],
    ["fertigWenn", /Fertig wenn:\s*/i],
  ];

  const hits = patterns
    .map(([key, re]) => {
      const m = re.exec(text);
      return m ? { key, index: m.index, len: m[0].length } : null;
    })
    .filter((x): x is { key: keyof Omit<ParsedInfoText, "remainder">; index: number; len: number } =>
      Boolean(x),
    )
    .sort((a, b) => a.index - b.index);

  if (hits.length === 0) {
    return {
      was: null,
      warum: null,
      ergebnis: null,
      fertigWenn: null,
      remainder: text,
    };
  }

  const out: ParsedInfoText = {
    was: null,
    warum: null,
    ergebnis: null,
    fertigWenn: null,
    remainder: hits[0]!.index > 0 ? text.slice(0, hits[0]!.index).trim() || null : null,
  };

  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i]!;
    const start = cur.index + cur.len;
    const end = i + 1 < hits.length ? hits[i + 1]!.index : text.length;
    const value = text.slice(start, end).trim().replace(/[.;]\s*$/, "") || null;
    out[cur.key] = value ? capitalizeSentence(value) : null;
  }

  return out;
}

export function softenShortDescription(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  for (const [re, replacement] of SHORT_DESCRIPTION_SOFTEN) {
    if (re.test(text)) return replacement;
  }
  return text;
}

export function softenResultSummary(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  for (const [re, replacement] of RESULT_SOFTEN) {
    if (re.test(text)) return replacement;
  }
  // Strip very technical prefixes when the rest is readable.
  return text
    .replace(/^Ergebnis:\s*/i, "")
    .replace(/^status\s*[:=]\s*/i, "")
    .trim();
}

/**
 * Maps persisted workflow status → user-facing display status.
 * Dependency waits stay "blocked" in DB but render as waiting, not alarm-red.
 */
export function getStepDisplayStatus(step: FahrplanStepLike): StepDisplayStatus {
  const status = String(step.status ?? "");
  if (step.completed || status === "completed") return "completed";
  if (status === "skipped") return "skipped";
  if (status === "failed") return "blocked";
  if (status === "in_progress") {
    if (
      step.completion_type === "file_validation" ||
      step.completion_type === "pipeline_success"
    ) {
      return "checking";
    }
    return "in_progress";
  }
  if (status === "waiting_for_input") {
    if (step.completion_type === "approval") return "waiting_for_approval";
    return "waiting_for_file";
  }
  if (status === "ready") return "ready";
  if (status === "not_started") return "not_ready";

  if (status === "blocked") {
    // Hard blocker only when an explicit error exists — dependency waits are not alarm-red.
    if (step.error_summary?.trim()) return "blocked";
    if (step.completion_type === "approval") return "waiting_for_approval";
    // Undefined prerequisites (badge without full step context) → dependency wait,
    // which is the common persisted meaning of "blocked" in this product.
    if (
      step.prerequisites === undefined ||
      step.prerequisites === null ||
      step.prerequisites.length > 0
    ) {
      return "waiting_for_prereq";
    }
    return step.required === false ? "waiting_for_approval" : "not_ready";
  }

  return "not_ready";
}

export function isHardBlockedDisplay(display: StepDisplayStatus): boolean {
  return display === "blocked";
}

export function isWaitingDisplay(display: StepDisplayStatus): boolean {
  return (
    display === "waiting_for_prereq" ||
    display === "waiting_for_file" ||
    display === "waiting_for_approval" ||
    display === "not_ready"
  );
}

export function computeDisplayProgress(steps: FahrplanStepLike[]) {
  const displays = steps.map((s) => getStepDisplayStatus(s));
  const total = steps.length;
  const completed = displays.filter((d) => d === "completed" || d === "skipped").length;
  const ready = displays.filter((d) => d === "ready" || d === "in_progress" || d === "checking").length;
  const waiting = displays.filter((d) => isWaitingDisplay(d)).length;
  const blocked = displays.filter((d) => isHardBlockedDisplay(d)).length;
  const open = total - completed;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, completed, open, ready, waiting, blocked, percent };
}

/** First actionable step — only one primary next action. */
export function findNextActionableStep<T extends FahrplanStepLike>(
  steps: T[],
): T | null {
  const ready = steps.find((s) => getStepDisplayStatus(s) === "ready");
  if (ready) return ready;
  const inFlight = steps.find((s) => {
    const d = getStepDisplayStatus(s);
    return d === "in_progress" || d === "checking" || d === "waiting_for_file";
  });
  return inFlight ?? null;
}

export function executionHint(step: FahrplanStepLike): string {
  const role = step.responsible_role?.trim();
  if (role === "customer_admin" || role === "admin") return "Projekt-Admin";
  if (role === "customer_user") return "Projekt-Benutzer";
  if (step.pipeline_step_key) return "Pipeline / Admin-App";
  if (step.adapter_key?.startsWith("sap_")) return "SAP-System";
  return "Admin-App";
}
