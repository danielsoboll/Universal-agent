/** Display metadata for checklist phases — UI labels only, not business logic. */

export const WORKFLOW_PHASES: Array<{ key: string; title: string; order: number }> = [
  { key: "vorbereitung", title: "Vorbereitung", order: 1 },
  { key: "ziel_und_scope", title: "Ziel und Scope", order: 2 },
  { key: "systeme_und_quellen", title: "Systeme und Quellen", order: 3 },
  { key: "datenexport", title: "Datenexport", order: 4 },
  { key: "upload_und_validierung", title: "Upload und Validierung", order: 5 },
  { key: "kanonisierung", title: "Kanonisierung", order: 6 },
  { key: "analyse_und_interpretation", title: "Analyse und Interpretation", order: 7 },
  { key: "verknuepfung_und_relationen", title: "Verknüpfung und Relationserkennung", order: 8 },
  { key: "indexierung", title: "Indexierung", order: 9 },
  { key: "qualitaetssicherung", title: "Qualitätssicherung", order: 10 },
  { key: "freigabe_fuer_anwender", title: "Freigabe für Anwender", order: 11 },
  { key: "betrieb_und_aktualisierung", title: "Betrieb und Aktualisierung", order: 12 },
];

export const STEP_STATUS_LABELS: Record<string, string> = {
  not_started: "Noch nicht bereit",
  ready: "Bereit",
  in_progress: "In Arbeit",
  waiting_for_input: "Wartet auf Datei",
  completed: "Abgeschlossen",
  skipped: "Übersprungen",
  blocked: "Wartet auf Voraussetzung",
  failed: "Blockiert",
};

export function phaseTitle(phaseKey: string): string {
  return WORKFLOW_PHASES.find((p) => p.key === phaseKey)?.title ?? phaseKey;
}

export function computeProgress(steps: Array<{ required: boolean; completed: boolean; status: string }>) {
  const required = steps.filter((s) => s.required && s.status !== "skipped");
  const done = required.filter((s) => s.completed).length;
  const blocked = steps.filter((s) => s.status === "blocked").length;
  const open = required.filter((s) => !s.completed).length;
  const pct = required.length === 0 ? 0 : Math.round((done / required.length) * 100);
  return { required: required.length, done, open, blocked, percent: pct };
}
