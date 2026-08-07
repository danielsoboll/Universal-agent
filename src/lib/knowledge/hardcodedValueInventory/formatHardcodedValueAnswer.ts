/**
 * Aggregate occurrences → material cards + answer view.
 */
import type {
  HardcodedMaterialCard,
  HardcodedOccurrence,
  HardcodedValueAnswerView,
} from "./types";

function pickBestStatus(
  occs: HardcodedOccurrence[],
): HardcodedOccurrence["claim_status"] {
  if (occs.some((o) => o.active_code && !o.comment_only)) {
    return "AUTHORITATIVE";
  }
  if (occs.some((o) => o.claim_status === "CODE_DERIVED")) {
    return "CODE_DERIVED";
  }
  return "INFERRED";
}

function evidenceLabel(
  status: HardcodedOccurrence["claim_status"],
  hasProcess: boolean,
): string {
  if (status === "AUTHORITATIVE" && hasProcess) {
    return "Im Code belegt / Prozess aus Code abgeleitet";
  }
  if (status === "AUTHORITATIVE") return "Im Code belegt";
  if (status === "CODE_DERIVED") return "Prozess aus Code abgeleitet";
  return "Vorsichtige Einordnung";
}

export function buildHardcodedValueAnswerView(params: {
  occurrences: HardcodedOccurrence[];
  units_scanned: number;
  units_with_matnr_context: number;
  excluded_sample: Array<{ literal: string; reason: string }>;
  sources: string[];
}): HardcodedValueAnswerView {
  const byMat = new Map<string, HardcodedOccurrence[]>();
  for (const o of params.occurrences) {
    const key = o.material_number_internal;
    const list = byMat.get(key) ?? [];
    list.push(o);
    byMat.set(key, list);
  }

  const materials: HardcodedMaterialCard[] = [];
  for (const [, occs] of [...byMat.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const active = occs.filter((o) => o.active_code);
    const primary = active.length ? active : occs;
    const status = pickBestStatus(primary);
    const processes = [
      ...new Set(
        primary.map((o) => o.process_label).filter((x): x is string => Boolean(x)),
      ),
    ];
    const conditions = [
      ...new Set(
        primary.map((o) => o.condition).filter((x): x is string => Boolean(x)),
      ),
    ];
    const effects = [
      ...new Set(
        primary.map((o) => o.action).filter((x): x is string => Boolean(x)),
      ),
    ];
    materials.push({
      material_number: primary[0]!.material_number,
      material_number_internal: primary[0]!.material_number_internal,
      occurrence_count: occs.length,
      process_label: processes[0] ?? null,
      condition_summary: conditions[0] ?? null,
      effect_summary: effects[0] ?? null,
      evidence_status: evidenceLabel(status, Boolean(processes[0])),
      claim_status: status,
      occurrences: occs,
    });
  }

  materials.sort(
    (a, b) =>
      b.occurrence_count - a.occurrence_count ||
      a.material_number.localeCompare(b.material_number),
  );

  const active_occurrence_count = params.occurrences.filter(
    (o) => o.active_code,
  ).length;
  const comment_only_count = params.occurrences.filter(
    (o) => o.comment_only,
  ).length;

  const unique = materials.filter((m) =>
    m.occurrences.some((o) => o.active_code),
  );
  const comment_or_unclear = materials.filter(
    (m) =>
      !m.occurrences.some((o) => o.active_code) ||
      m.claim_status === "INFERRED",
  );
  const multi_use = unique.filter((m) => m.occurrence_count >= 2);

  const X = unique.length;
  const Y = active_occurrence_count;
  const text =
    X === 0
      ? "Im aktuell verarbeiteten Quellcode wurden keine eindeutig als Materialnummern belegten hart codierten Werte gefunden."
      : `Im kundeneigenen Code wurden ${X} fest hinterlegte Materialnummern an ${Y} aktiven Stellen gefunden. Unten sehen Sie je Nummer den erkennbaren Prozessbezug, die Bedingung und die Auswirkung.`;

  const missing_information: string[] = [];
  if (X === 0) {
    missing_information.push(
      "Keine MATNR-gebundenen Literale mit belastbarem Materialkontext im gescannten Bestand.",
    );
  }
  if (unique.some((m) => !m.process_label)) {
    missing_information.push(
      "Für einzelne Nummern ist der Geschäftsprozess aus den vorliegenden Codebelegen noch nicht eindeutig ableitbar.",
    );
  }

  return {
    summary: {
      text,
      unique_material_count: X,
      active_occurrence_count: Y,
      comment_only_count,
      excluded_literal_count: params.excluded_sample.length,
      units_scanned: params.units_scanned,
      units_with_matnr_context: params.units_with_matnr_context,
    },
    materials: unique,
    multi_use,
    comment_or_unclear,
    excluded_sample: params.excluded_sample.slice(0, 40),
    missing_information,
    sources: params.sources,
  };
}
