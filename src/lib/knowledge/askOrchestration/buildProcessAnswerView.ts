/**
 * Build structured PROCESS_EXPLANATION answer from gated evidence.
 * Methods without analysis → technical findings, not process steps.
 */
import type { RelevanceGateResult } from "./orchestrationRelevanceGate";
import type {
  ProcessAnswerView,
  ProcessStepView,
  TechnicalObjectChip,
} from "./relevanceGateTypes";

function dedupeChips(chips: TechnicalObjectChip[]): TechnicalObjectChip[] {
  const seen = new Set<string>();
  const out: TechnicalObjectChip[] = [];
  for (const c of chips) {
    const k = `${c.role}|${c.object_type}|${c.object_name}|${c.unit_name ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function analysisToStep(params: {
  object_name: string;
  unit_name: string;
  summary: string;
  source_key: string;
}): ProcessStepView {
  // Prefer fachliche summary; attach method as technical ref
  const text = params.summary.trim().replace(/\s+/g, " ");
  return {
    text,
    technical_refs: [`${params.object_name}->${params.unit_name}`],
    source_keys: [params.source_key],
    from_analysis: true,
  };
}

function inferObjectTypeFromSourceKey(source_key: string | null | undefined): string {
  const k = (source_key ?? "").toUpperCase();
  if (k.includes("|CLASS|")) return "CLASS";
  if (k.includes("|PROGRAM|")) return "PROGRAM";
  if (k.includes("|FUNCTION_MODULE|") || k.includes("|FUNCTION|")) {
    return "FUNCTION_MODULE";
  }
  if (k.includes("|INTERFACE|")) return "INTERFACE";
  return "CODE_OBJECT";
}

export function buildProcessAnswerView(params: {
  question: string;
  gate: RelevanceGateResult;
}): ProcessAnswerView {
  const { gate } = params;
  const primaryCode = gate.accepted.filter(
    (c) => c.kind === "CODE_UNIT" && c.tier === "PRIMARY",
  );
  const secondaryCode = gate.accepted.filter(
    (c) => c.kind === "CODE_UNIT" && c.tier === "SECONDARY",
  );

  const typeByName = new Map<string, string>();
  for (const c of [...primaryCode, ...secondaryCode]) {
    const t = inferObjectTypeFromSourceKey(c.source_key);
    const prev = typeByName.get(c.object_name.toUpperCase());
    if (!prev || t === "CLASS" || t === "PROGRAM" || t === "FUNCTION_MODULE") {
      typeByName.set(c.object_name.toUpperCase(), t);
    }
  }

  const technical_anchors: TechnicalObjectChip[] = gate.strong_seeds.map(
    (s) => ({
      object_type: typeByName.get(s.toUpperCase()) ?? "CODE_OBJECT",
      object_name: s,
      unit_name: null,
      role: "anchor" as const,
    }),
  );

  const process_steps: ProcessStepView[] = [];
  const methodsWithAnalysis = new Set<string>();

  for (const a of gate.filtered_analyses) {
    if (!a.summary?.trim()) continue;
    const step = analysisToStep({
      object_name: a.object_name,
      unit_name: a.unit_name,
      summary: a.summary,
      source_key: a.source_key,
    });
    process_steps.push(step);
    methodsWithAnalysis.add(
      `${a.object_name.toUpperCase()}|${a.unit_name.toUpperCase()}`,
    );
    if (process_steps.length >= 8) break;
  }

  const technical_findings: TechnicalObjectChip[] = [];
  for (const c of [...primaryCode, ...secondaryCode]) {
    if (!c.unit_name) continue;
    const key = `${c.object_name.toUpperCase()}|${c.unit_name.toUpperCase()}`;
    if (methodsWithAnalysis.has(key)) continue;
    technical_findings.push({
      object_type: "METHOD",
      object_name: c.object_name,
      unit_name: c.unit_name,
      role: "participant",
    });
  }

  const participants = dedupeChips([
    ...[...primaryCode, ...secondaryCode].map((c) => ({
      object_type: c.object_type,
      object_name: c.object_name,
      unit_name: null as string | null,
      role: "participant" as const,
    })),
  ]);

  const tables_fields_config = dedupeChips([
    ...gate.field_refs.map((f) => ({
      object_type: "FIELD",
      object_name: f.object_name,
      unit_name: null as string | null,
      role: "field" as const,
    })),
    ...gate.accepted
      .filter((c) => c.kind === "AUTHORITATIVE_NODE" && c.tier !== "EXCLUDED")
      .map((c) => ({
        object_type: c.object_type,
        object_name: c.object_name,
        unit_name: null as string | null,
        role: "config" as const,
      })),
  ]);

  const open_points: string[] = [];
  if (process_steps.length === 0 && technical_findings.length > 0) {
    open_points.push(
      "Für die gefundenen Methoden liegt keine inhaltliche Methodenanalyse vor — daher nur technische Fundstellen, keine erklärten Prozessschritte.",
    );
  }
  if (gate.strong_seeds.length === 0) {
    open_points.push(
      "Kein eindeutiger technischer Prozessanker aus den Suchbegriffen ableitbar.",
    );
  }

  const anchorLabel =
    technical_anchors.map((a) => a.object_name).join(", ") ||
    "(kein Anker)";
  const summary =
    process_steps.length > 0
      ? `Zum Prozessanker ${anchorLabel} liegen ${process_steps.length} belegte Ablaufschritte und ${participants.length} beteiligte Objekte vor.`
      : `Zum Prozessanker ${anchorLabel} wurden ${technical_findings.length} technische Fundstellen ermittelt` +
        (tables_fields_config.length
          ? `; ${tables_fields_config.length} Tabellen/Felder/Konfigurationen sind dem Anker zuordenbar.`
          : ".") ;

  // Dedupe evidence by source_key / display
  const evidenceSeen = new Set<string>();
  const evidence: ProcessAnswerView["evidence"] = [];
  for (const c of gate.accepted) {
    const sk = c.source_key ?? c.display;
    if (evidenceSeen.has(sk)) continue;
    evidenceSeen.add(sk);
    evidence.push({
      source_key: sk,
      label: c.display,
      tier: c.tier,
    });
  }

  return {
    summary,
    technical_anchors,
    process_steps,
    technical_findings: technical_findings.slice(0, 40),
    participants,
    tables_fields_config: tables_fields_config.slice(0, 30),
    open_points,
    evidence: evidence.slice(0, 60),
    relevance: {
      candidates_before: gate.candidates_before.length,
      candidates_after: gate.accepted.length,
      excluded_shared_token_only: gate.excluded_shared_token_only,
      accepted_paths: gate.accepted_paths,
      query_terms: gate.query_terms,
      strong_seeds: gate.strong_seeds,
    },
  };
}
