/**
 * Generic answer formatting by orchestration intent.
 */
import type { AskOrchestrationIntent } from "./classifyAskIntent";
import type { EvidenceCoverageReport } from "./evidenceBudget";
import type { VerifiedClaim } from "./claimVerifier";
import { phraseClaim } from "./claimVerifier";
import type { GraphFirstRetrieval } from "./graphFirstRetrieval";

export function formatOrchestratedAnswer(params: {
  intent: AskOrchestrationIntent;
  question: string;
  coverage: EvidenceCoverageReport;
  claims: VerifiedClaim[];
  graph: GraphFirstRetrieval | null;
  inventory_markdown?: string | null;
  entity_list_markdown?: string | null;
  process_answer_view?: import("./relevanceGateTypes").ProcessAnswerView | null;
}): string {
  if (params.intent === "INVENTORY_AND_AGGREGATION" && params.inventory_markdown) {
    return params.inventory_markdown;
  }

  if (params.intent === "ENTITY_LIST" && params.entity_list_markdown) {
    return params.entity_list_markdown;
  }

  if (
    (params.intent === "PROCESS_EXPLANATION" ||
      params.intent === "TECHNICAL_TRACE") &&
    params.process_answer_view
  ) {
    return params.process_answer_view.summary;
  }

  const kept = params.claims
    .map(phraseClaim)
    .filter((x): x is string => Boolean(x));

  if (!params.coverage.sufficient) {
    const parts = [
      `Die verfügbare Evidenz reicht für eine vollständige Antwort auf „${params.question.trim()}“ noch nicht aus.`,
      "",
      "### Noch offen / fehlend",
      ...params.coverage.missing.map((m) => `- ${m}`),
    ];
    if (kept.length) {
      parts.push("", "### Sicher belegt (Teilbefund)", ...kept.map((c) => `- ${c}`));
    }
    if (params.graph?.seeds.length) {
      parts.push("", `Seeds: ${params.graph.seeds.join(", ")}`);
    }
    if (params.graph?.canonical_sources.length) {
      parts.push(
        "",
        "### Quellen",
        ...params.graph.canonical_sources.map((s) => `- ${s}`),
      );
    }
    return parts.join("\n");
  }

  if (
    params.intent === "PROCESS_EXPLANATION" ||
    params.intent === "TECHNICAL_TRACE"
  ) {
    return formatProcessOrTrace({
      intent: params.intent,
      question: params.question,
      kept,
      graph: params.graph,
    });
  }

  if (params.intent === "OBJECT_LOOKUP") {
    const parts = [
      kept[0] ?? "Objekt im Bestand gefunden — siehe Belege.",
      "",
      "### Technischer Anker",
      ...(params.graph?.authoritative_nodes.slice(0, 8).map((n) => `- ${n}`) ??
        ["- (kein autoritativer Node)"]),
      "",
      "### Code / Analysen (Cache)",
      ...(params.graph?.cached_analyses.slice(0, 8).map(
        (a) =>
          `- ${a.object_name}.${a.unit_name}: ${a.summary ?? "(ohne Summary)"}`,
      ) ?? ["- keine Cache-Treffer"]),
      "",
      "### Sicher belegt",
      ...kept.map((c) => `- ${c}`),
      "",
      "### Quellen",
      ...(params.graph?.canonical_sources.map((s) => `- ${s}`) ?? []),
    ];
    return parts.join("\n");
  }

  // COMPARISON / UNKNOWN
  return [
    kept[0] ?? "Teilbefund aus Graph/Canonical.",
    "",
    "### Sicher belegt",
    ...kept.map((c) => `- ${c}`),
    "",
    "### Noch offen",
    ...(params.coverage.missing.length
      ? params.coverage.missing.map((m) => `- ${m}`)
      : ["- —"]),
  ].join("\n");
}

function formatProcessOrTrace(params: {
  intent: AskOrchestrationIntent;
  question: string;
  kept: string[];
  graph: GraphFirstRetrieval | null;
}): string {
  const g = params.graph;
  const steps: string[] = [];
  if (g?.cached_analyses.length) {
    for (const a of g.cached_analyses.slice(0, 6)) {
      if (a.summary) steps.push(`${a.object_name}.${a.unit_name}: ${a.summary}`);
    }
  }
  if (g?.graph_paths.length && steps.length < 2) {
    for (const p of g.graph_paths.slice(0, 6)) {
      const rel = p.path_relations.length
        ? ` via ${p.path_relations.join(" → ")}`
        : "";
      steps.push(`${p.object_name}.${p.unit_name} (Distanz ${p.distance}${rel})`);
    }
  }

  const programs = [
    ...new Set(g?.graph_paths.map((p) => p.object_name) ?? []),
  ].slice(0, 12);

  const parts = [
    params.kept[0] ??
      `Kurzfassung zu „${params.question.trim()}“ aus Graph- und Cache-Evidenz.`,
    "",
    "### Technischer Anker",
    ...(g?.seeds.length ? g.seeds.map((s) => `- ${s}`) : ["- (keine Seeds)"]),
    "",
    "### Ablauf in Schritten",
    ...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ["1. (noch offen)"]),
    "",
    "### Beteiligte Programme/Klassen/Methoden",
    ...(programs.length ? programs.map((p) => `- ${p}`) : ["- —"]),
    "",
    "### Tabellen/Felder/Konfiguration",
    ...(g?.authoritative_nodes.slice(0, 10).map((n) => `- ${n}`) ?? ["- —"]),
    "",
    "### Sicher belegt",
    ...params.kept.map((c) => `- ${c}`),
    "",
    "### Noch offen",
    ...(g?.graph_paths.some((p) => p.path_relations.length === 0)
      ? ["- einzelne Pfade ohne Relation-Kante"]
      : []),
    ...(g?.relation_hops && g.relation_hops.edges === 0
      ? ["- keine Relation-Hops gefunden"]
      : ["- —"]),
    "",
    "### Quellen",
    ...(g?.canonical_sources.map((s) => `- ${s}`) ?? []),
  ];
  return parts.join("\n");
}
