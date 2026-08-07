/**
 * Map hardcoded-value scan → Prozessantwort + technische Details (Anwender-Sprache).
 */
import type {
  ClassifiedStatement,
  CompactTechnicalDetails,
  ProcessAnswer,
  TechnicalAnswer,
  TechnicalDetails,
} from "@/lib/knowledge/answerSchema";
import {
  EMPTY_COMPACT_TECHNICAL_DETAILS,
  EMPTY_PROCESS_ANSWER,
  EMPTY_TECHNICAL_ANSWER,
  EMPTY_TECHNICAL_DETAILS,
} from "@/lib/knowledge/answerSchema";
import type {
  HardcodedMaterialCard,
  HardcodedValueAnswerView,
} from "./types";

function stmt(
  text: string,
  level: ClassifiedStatement["level"],
): ClassifiedStatement {
  return { text, level, source_ranks: [1], source_ids: [] };
}

function locLabel(card: HardcodedMaterialCard): string {
  const o = (card.occurrences ?? []).find((x) => x.active_code) ?? card.occurrences?.[0];
  if (!o) return card.material_number;
  const unit =
    o.unit_name && o.unit_name !== o.object_name
      ? `${o.object_name}→${o.unit_name}`
      : o.object_name;
  return unit;
}

function materialProcessLine(m: HardcodedMaterialCard): string {
  const proc = m.process_label?.trim();
  const cond = m.condition_summary?.trim();
  const eff = m.effect_summary?.trim();
  const parts = [
    `Material ${m.material_number} (${m.occurrence_count} Fundstelle${m.occurrence_count === 1 ? "" : "n"})`,
    proc ? `Prozess: ${proc}` : null,
    cond ? `Bedingung: ${cond}` : null,
    eff ? `Wirkung: ${eff}` : null,
    `Beleg: ${locLabel(m)}`,
  ].filter(Boolean);
  return parts.join(" — ");
}

function clusterThemes(materials: HardcodedMaterialCard[]): string {
  const counts = new Map<string, number>();
  for (const m of materials) {
    const p = m.process_label?.trim();
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + m.occurrence_count);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name]) => name);
  if (top.length === 0) return "";
  return `Häufige Prozessthemen: ${top.join("; ")}.`;
}

export function buildHardcodedProcessAnswer(
  view: HardcodedValueAnswerView,
): ProcessAnswer {
  const s = view.summary;
  const materials = view.materials ?? [];
  const withProcess = materials.filter((m) => m.process_label?.trim());
  const withoutProcess = materials.filter((m) => !m.process_label?.trim());

  const confirmed = materials
    .filter(
      (m) =>
        m.claim_status === "AUTHORITATIVE" ||
        (m.claim_status === "CODE_DERIVED" && m.process_label),
    )
    .slice(0, 12)
    .map((m) => stmt(materialProcessLine(m), "confirmed"));

  const inferred = materials
    .filter(
      (m) =>
        m.claim_status === "INFERRED" ||
        (!m.process_label?.trim() && Boolean(m.condition_summary?.trim())),
    )
    .slice(0, 10)
    .map((m) => stmt(materialProcessLine(m), "inferred"));

  const open = [
    ...(view.missing_information ?? []).map((t) => stmt(t, "possible")),
    ...withoutProcess
      .slice(0, 6)
      .map((m) =>
        stmt(
          `Material ${m.material_number}: Prozessbezug aus Code/Analysen noch nicht eindeutig (${locLabel(m)}).`,
          "possible",
        ),
      ),
  ];

  const theme = clusterThemes(materials);
  const business_interpretation = theme
    ? `${theme} Hart codierte Materialnummern steuern Sonderlogik, wenn im Laufzeitcode ein MATNR-Feld mit dem fest hinterlegten Wert verglichen wird.`
    : materials.length > 0
      ? "Fest hinterlegte Materialnummern steuern im ABAP-Code Verzweigungen und Sonderbehandlungen — typisch bei EDI, Touren, Fakturierung oder Leerwert-Prüfungen."
      : "";

  return {
    ...EMPTY_PROCESS_ANSWER,
    direct_answer: s.text,
    special_process:
      materials.length > 0
        ? `${s.unique_material_count} Materialnummern an ${s.active_occurrence_count} aktiven Code-Stellen`
        : "",
    trigger:
      s.units_with_matnr_context > 0
        ? "Direkter Vergleich oder Prüfung von MATNR-Feldern gegen fest hinterlegte Literale im Quellcode"
        : "",
    process_effect:
      withProcess.length > 0
        ? "Bei Treffer greift programmspezifische Sonderlogik (Mapping, Filter, Ausschluss oder alternative Verarbeitung)."
        : "",
    business_interpretation,
    has_safe_process_claim: s.unique_material_count > 0,
    open_validation_questions: view.missing_information ?? [],
    confirmed,
    inferred,
    open,
  };
}

export function buildHardcodedTechnicalAnswer(
  view: HardcodedValueAnswerView,
): TechnicalAnswer {
  const materials = view.materials ?? [];
  const objects = new Set<string>();
  const processing: ClassifiedStatement[] = [];
  const triggers = new Set<string>();
  const results = new Set<string>();

  for (const m of materials.slice(0, 15)) {
    for (const o of (m.occurrences ?? []).filter((x) => x.active_code).slice(0, 2)) {
      objects.add(o.object_name);
      if (o.condition) triggers.add(o.condition);
      if (o.action) results.add(o.action);
      const unit =
        o.unit_name && o.unit_name !== o.object_name
          ? `${o.object_name}.${o.unit_name}`
          : o.object_name;
      const line = o.line_number != null ? `:${o.line_number}` : "";
      processing.push(
        stmt(
          `${unit}${line} — MATNR ${m.material_number}: ${o.snippet.slice(0, 160)}`,
          o.comment_only ? "inferred" : "confirmed",
        ),
      );
    }
  }

  return {
    ...EMPTY_TECHNICAL_ANSWER,
    entry_point: [
      stmt(
        `Code-Scan über ${view.summary.units_scanned} Einheiten (${view.summary.units_with_matnr_context} mit MATNR-Kontext)`,
        "confirmed",
      ),
    ],
    trigger: [
      stmt(
        "Fest hinterlegte Materialnummern in IF/CASE/SELECT/WHERE — Vergleich gegen MATNR oder materialbezogene Felder",
        "confirmed",
      ),
      ...[...triggers].slice(0, 5).map((t) => stmt(t, "confirmed")),
    ],
    processing: processing.slice(0, 12),
    objects: [...objects]
      .slice(0, 12)
      .map((o) => stmt(`Programm/Klasse: ${o}`, "confirmed")),
    results: [
      ...[...results].slice(0, 6).map((r) => stmt(r, "confirmed")),
      ...materials
        .filter((m) => m.effect_summary)
        .slice(0, 6)
        .map((m) => stmt(`${m.material_number}: ${m.effect_summary}`, "confirmed")),
    ],
    relations: view.multi_use?.length
      ? view.multi_use.slice(0, 6).map((m) =>
          stmt(
            `${m.material_number} in ${m.occurrence_count} Fundstellen — u. a. ${locLabel(m)}`,
            "confirmed",
          ),
        )
      : [],
    open: (view.missing_information ?? []).map((t) => stmt(t, "possible")),
  };
}

export function buildHardcodedCompactTechnicalDetails(
  view: HardcodedValueAnswerView,
): CompactTechnicalDetails {
  const materials = view.materials ?? [];
  const beleg: string[] = [];
  for (const m of materials.slice(0, 8)) {
    const o = (m.occurrences ?? []).find((x) => x.active_code) ?? m.occurrences?.[0];
    if (!o) continue;
    beleg.push(
      `${o.object_name}${o.unit_name && o.unit_name !== o.object_name ? `.${o.unit_name}` : ""}: ${o.snippet.slice(0, 120)}`,
    );
  }

  const systemaktion = [
    ...new Set(
      materials
        .map((m) => m.effect_summary?.trim())
        .filter((x): x is string => Boolean(x)),
    ),
  ].slice(0, 6);

  return {
    ...EMPTY_COMPACT_TECHNICAL_DETAILS,
    quelle: (view.sources ?? []).slice(0, 6),
    ausloeser: [
      "MATNR-Vergleich gegen im Code fest hinterlegte Material-Literale",
      `${view.summary.unique_material_count} eindeutige Nummern, ${view.summary.active_occurrence_count} aktive Fundstellen`,
    ],
    systemaktion,
    beleg,
    unsicherheit: view.missing_information ?? [],
    hidden_hardcodings: (view.excluded_sample ?? [])
      .slice(0, 12)
      .map((e) => `${e.literal} (${e.reason})`),
  };
}

export function buildHardcodedTechnicalDetails(
  view: HardcodedValueAnswerView,
): TechnicalDetails {
  const hardcoded_values = (view.materials ?? [])
    .slice(0, 40)
    .map(
      (m) =>
        `${m.material_number} (${m.occurrence_count}×)${m.process_label ? ` — ${m.process_label}` : ""}`,
    );
  const conditions = (view.materials ?? [])
    .filter((m) => m.condition_summary)
    .slice(0, 20)
    .map((m) => `${m.material_number}: ${m.condition_summary}`);
  const evidence = (view.materials ?? [])
    .flatMap((m) => (m.occurrences ?? []).slice(0, 2))
    .slice(0, 25)
    .map(
      (o) =>
        `${o.object_name}${o.line_number != null ? `:${o.line_number}` : ""} — ${o.snippet.slice(0, 100)}`,
    );

  return {
    ...EMPTY_TECHNICAL_DETAILS,
    sources: (view.sources ?? []).slice(0, 8),
    conditions,
    hardcoded_values,
    evidence,
    facts: [`${view.summary.units_scanned} Codeeinheiten gescannt`],
    inferences: view.missing_information ?? [],
    confidence: view.summary.unique_material_count > 0 ? 0.9 : 0.3,
  };
}

export function buildHardcodedUserAnswers(view: HardcodedValueAnswerView): {
  process_answer: ProcessAnswer;
  technical_answer: TechnicalAnswer;
  compact_technical_details: CompactTechnicalDetails;
  technical_details: TechnicalDetails;
} {
  return {
    process_answer: buildHardcodedProcessAnswer(view),
    technical_answer: buildHardcodedTechnicalAnswer(view),
    compact_technical_details: buildHardcodedCompactTechnicalDetails(view),
    technical_details: buildHardcodedTechnicalDetails(view),
  };
}
