/**
 * Build / merge Evidence Graph and Evidence Package for synthesis.
 */
import { ensureWritableDir, writeGeneratedText } from "@/lib/localData/fs";
import type { AnchorInventory } from "./types";
import type {
  EvidenceGraph,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  EvidencePackage,
} from "./types";
import { EVIDENCE_GRAPH_SCHEMA_VERSION } from "./types";

export function mergeGraphNodes(
  ...lists: EvidenceGraphNode[][]
): EvidenceGraphNode[] {
  const map = new Map<string, EvidenceGraphNode>();
  for (const list of lists) {
    for (const n of list) {
      const prev = map.get(n.id);
      if (!prev || n.score > prev.score || (n.exact_match && !prev.exact_match)) {
        map.set(n.id, n);
      }
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

export function mergeGraphEdges(
  ...lists: EvidenceGraphEdge[][]
): EvidenceGraphEdge[] {
  const map = new Map<string, EvidenceGraphEdge>();
  for (const list of lists) {
    for (const e of list) {
      const k = `${e.from}|${e.relation}|${e.to}`;
      const prev = map.get(k);
      if (!prev || e.confidence > prev.confidence) map.set(k, e);
    }
  }
  return [...map.values()];
}

export function buildEvidenceGraph(params: {
  question: string;
  primaryAnchors: string[];
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
}): EvidenceGraph {
  return {
    schema_version: EVIDENCE_GRAPH_SCHEMA_VERSION,
    question: params.question,
    primary_anchors: params.primaryAnchors,
    nodes: params.nodes,
    edges: params.edges,
    generated_at: new Date().toISOString(),
  };
}

export function persistEvidenceGraph(
  projectKey: string,
  runId: string,
  graph: EvidenceGraph,
): string {
  const rel = `search-runs/${runId}`;
  ensureWritableDir(projectKey, "logs", rel);
  writeGeneratedText(
    projectKey,
    "logs",
    `${rel}/evidence-graph.json`,
    `${JSON.stringify(graph, null, 2)}\n`,
  );
  return `logs/${rel}/evidence-graph.json`;
}

export function persistAnchorInventories(
  projectKey: string,
  runId: string,
  inventories: AnchorInventory[],
): string {
  const rel = `search-runs/${runId}`;
  ensureWritableDir(projectKey, "logs", rel);
  writeGeneratedText(
    projectKey,
    "logs",
    `${rel}/anchor-inventory.json`,
    `${JSON.stringify(inventories, null, 2)}\n`,
  );
  return `logs/${rel}/anchor-inventory.json`;
}

function nodesOfType(graph: EvidenceGraph, types: string[]) {
  const set = new Set(types);
  return graph.nodes.filter(
    (n) => set.has(n.type) && n.name !== "?" && !n.id.endsWith(":?"),
  );
}

function edgesOf(graph: EvidenceGraph, kinds: string[]) {
  const set = new Set(kinds);
  return graph.edges.filter((e) => set.has(e.relation));
}

/** True when an edge endpoint is an unresolved placeholder. */
export function isUnresolvedGraphRef(ref: string): boolean {
  const u = ref.toUpperCase();
  return (
    u.includes(":?") ||
    u.endsWith(":?") ||
    u.includes("/?") ||
    /(^|\W)\?(?=$|\W)/.test(ref) ||
    /NODE:[A-Z_]+:\?$/i.test(ref)
  );
}

export function isResolvedEvidenceEdge(e: EvidenceGraphEdge): boolean {
  if (isUnresolvedGraphRef(e.from) || isUnresolvedGraphRef(e.to)) return false;
  if (
    e.resolution === "DYNAMIC_UNRESOLVED" ||
    e.resolution === "SOURCE_SCOPE_UNKNOWN"
  ) {
    return false;
  }
  return true;
}

/**
 * Curated package for final synthesis — not a raw hit dump.
 */
export function buildEvidencePackage(params: {
  question: string;
  graph: EvidenceGraph;
  inventories: AnchorInventory[];
  sourceCoverage?: Record<string, string | number>;
  maxItems?: number;
  /** Compact package for fast exact-symbol synthesis. */
  compact?: boolean;
}): EvidencePackage {
  const compact = params.compact === true;
  const max = params.maxItems ?? (compact ? 12 : 40);
  const g = params.graph;

  const configNodes = nodesOfType(g, [
    "OUTPUT_TYPE",
    "OUTPUT_TYPE_TEXT",
    "OUTPUT_PROCESSING",
    "MESSAGE_TYPE",
    "IDOC_TYPE",
    "IDOC_EXTENSION",
    "IDOC_SEGMENT",
    "PROCESS_CODE",
    "PORT",
  ]);
  const primaryU = g.primary_anchors.map((a) => a.toUpperCase());
  const configRanked = [...configNodes].sort((a, b) => {
    const as = primaryU.some(
      (p) =>
        a.name.toUpperCase().includes(p) ||
        a.id.toUpperCase().includes(p) ||
        String(a.attributes.KSCHL ?? "")
          .toUpperCase()
          .includes(p),
    )
      ? 1
      : 0;
    const bs = primaryU.some(
      (p) =>
        b.name.toUpperCase().includes(p) ||
        b.id.toUpperCase().includes(p) ||
        String(b.attributes.KSCHL ?? "")
          .toUpperCase()
          .includes(p),
    )
      ? 1
      : 0;
    if (as !== bs) return bs - as;
    return (b.exact_match ? 1 : 0) - (a.exact_match ? 1 : 0);
  }).slice(0, max);

  const codeUnits = nodesOfType(g, [
    "PROGRAM",
    "INCLUDE",
    "FORM_ROUTINE",
    "FUNCTION_MODULE",
    "METHOD",
    "CLASS",
  ])
    .filter((n) => n.name !== "?" && !isUnresolvedGraphRef(n.id))
    .sort((a, b) => {
      const as = primaryU.some((p) => a.name.toUpperCase().includes(p) || a.id.toUpperCase().includes(p))
        ? 1
        : 0;
      const bs = primaryU.some((p) => b.name.toUpperCase().includes(p) || b.id.toUpperCase().includes(p))
        ? 1
        : 0;
      return bs - as;
    })
    .slice(0, max);

  const allCallChains = edgesOf(g, [
    "OUTPUT_TYPE_PROCESSED_BY_PROGRAM",
    "OUTPUT_TYPE_USES_ROUTINE",
    "CODE_CALLS_FUNCTION_MODULE",
    "CODE_CALLS_METHOD",
    "CODE_PERFORMS_FORM_ROUTINE",
    "PROCESS_CODE_CALLS_FUNCTION_MODULE",
    "TECHNICAL_OBJECT_TO_PROGRAM",
    "TECHNICAL_OBJECT_TO_FUNCTION_MODULE",
    "PROGRAM_CONTAINS_FORM_ROUTINE",
    "OUTPUT_TYPE_USES_MEDIUM",
  ]);

  const relatedToPrimary = (e: EvidenceGraphEdge) =>
    primaryU.some(
      (p) =>
        e.from.toUpperCase().includes(p) ||
        e.to.toUpperCase().includes(p),
    );

  const callChains = allCallChains
    .filter(isResolvedEvidenceEdge)
    .sort((a, b) => Number(relatedToPrimary(b)) - Number(relatedToPrimary(a)))
    .slice(0, max);
  const unresolvedChains = allCallChains
    .filter((e) => !isResolvedEvidenceEdge(e))
    .slice(0, compact ? 8 : 20);

  const tableAccesses = edgesOf(g, [
    "CODE_READS_TABLE",
    "CODE_WRITES_TABLE",
    "CODE_USES_FIELD",
    "CODE_READS_CONTROL_TABLE",
  ])
    .filter(isResolvedEvidenceEdge)
    .slice(0, compact ? 8 : max);

  const controlRows = nodesOfType(g, [
    "CONTROL_TABLE",
    "CONTROL_TABLE_ROW",
  ]).slice(0, compact ? 4 : max);

  const master = nodesOfType(g, [
    "MASTER_DATA_FIELD",
    "MASTER_DATA_VALUE",
    "MASTER_DATA_ENTITY",
  ]).slice(0, compact ? 4 : max);

  const partners = nodesOfType(g, ["PARTNER_PROFILE"]).slice(0, max);
  const customers = [
    ...edgesOf(g, [
      "CONTROL_ROW_REFERENCES_CUSTOMER",
      "PARTNER_NUMBER_MATCHES_CUSTOMER",
    ]).filter(isResolvedEvidenceEdge),
    ...nodesOfType(g, ["MASTER_DATA_ENTITY"]).filter((n) =>
      String(n.attributes.entity_type ?? "")
        .toLowerCase()
        .includes("customer"),
    ),
  ].slice(0, max);

  const proven: string[] = [];
  for (const n of configRanked.filter((x) => x.exact_match).slice(0, 12)) {
    proven.push(`${n.type} ${n.name} (exact, ${n.source_path})`);
  }
  for (const e of callChains.filter(relatedToPrimary).slice(0, 12)) {
    const fromName = e.from.replace(/^node:[^:]+:/, "");
    const toName = e.to.replace(/^node:[^:]+:/, "");
    if (fromName === "?" || toName === "?") continue;
    proven.push(`${e.relation}: ${fromName} → ${toName}`);
  }

  const open: string[] = [];
  const hasOutput = configRanked.some((n) => n.type === "OUTPUT_TYPE");
  const hasPartner = partners.length > 0;
  const hasIdoc = configRanked.some((n) => n.type === "IDOC_TYPE");
  if (hasOutput && !hasIdoc) {
    open.push(
      "Output-/Nachrichtenkonfiguration gefunden, aber keine IDoc-Typ-Zuordnung im Graph.",
    );
  }
  if (hasOutput && !hasPartner) {
    open.push("Keine Partnerprofile im expandierten Evidenzgraph.");
  }
  if (codeUnits.length === 0 && configRanked.length > 0) {
    open.push(
      "Konfigurationsobjekte vorhanden, aber noch keine aufgelösten Code-Einheiten.",
    );
  }
  for (const e of unresolvedChains.slice(0, 10)) {
    open.push(
      `Technisch offen (unaufgelöste Relation ${e.resolution ?? "SOURCE_SCOPE_UNKNOWN"}): ${e.relation} ${e.from} → ${e.to}`,
    );
  }

  const idocConfiguration = {
    output_types: configRanked.filter((n) => n.type === "OUTPUT_TYPE"),
    texts: configRanked.filter((n) => n.type === "OUTPUT_TYPE_TEXT"),
    processing: configRanked.filter((n) => n.type === "OUTPUT_PROCESSING"),
    message_types: configRanked.filter((n) => n.type === "MESSAGE_TYPE"),
    idoc_types: configRanked.filter((n) => n.type === "IDOC_TYPE"),
    extensions: configRanked.filter((n) => n.type === "IDOC_EXTENSION"),
    segments: configRanked.filter((n) => n.type === "IDOC_SEGMENT"),
    process_codes: configRanked.filter((n) => n.type === "PROCESS_CODE"),
    ports: configRanked.filter((n) => n.type === "PORT"),
  };

  const coverage: Record<string, string | number> = {
    ...(params.sourceCoverage ?? {}),
    nodes: g.nodes.length,
    edges: g.edges.length,
    inventories: params.inventories.length,
    unresolved_edges: unresolvedChains.length,
  };
  for (const inv of params.inventories) {
    for (const [t, c] of Object.entries(inv.hits_by_type)) {
      if (c > 0) coverage[`anchor:${inv.anchor}:${t}`] = c;
    }
  }

  return {
    question: params.question,
    primary_anchors: g.primary_anchors,
    configuration: {
      nodes: configRanked,
      medium_edges: edgesOf(g, ["OUTPUT_TYPE_USES_MEDIUM"]).filter(
        isResolvedEvidenceEdge,
      ),
    },
    code_units: codeUnits,
    call_chains: callChains,
    table_accesses: tableAccesses,
    control_rows: controlRows,
    master_data_contexts: master,
    idoc_configuration: idocConfiguration,
    partners,
    customers,
    proven_claims: proven,
    inferred_claims: [],
    conflicts: [],
    open_questions: open,
    source_coverage: coverage,
  };
}

export function persistEvidencePackage(
  projectKey: string,
  runId: string,
  pkg: EvidencePackage,
): string {
  const rel = `search-runs/${runId}`;
  ensureWritableDir(projectKey, "logs", rel);
  writeGeneratedText(
    projectKey,
    "logs",
    `${rel}/evidence-package.json`,
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  return `logs/${rel}/evidence-package.json`;
}

/** Compact text block for LLM synthesis. */
export function evidencePackageToPromptBlock(
  pkg: EvidencePackage,
  opts?: { compact?: boolean },
): string {
  const compact = opts?.compact === true;
  const lines: string[] = [];
  lines.push(`# Evidence Package`);
  lines.push(`Question: ${pkg.question}`);
  lines.push(`Primary anchors: ${pkg.primary_anchors.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("## Proven claims (nur diese als belegt verwenden)");
  for (const c of pkg.proven_claims.slice(0, compact ? 22 : 30)) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push("## Configuration (fachlich)");
  const idoc = pkg.idoc_configuration as {
    output_types?: Array<{ name?: string; attributes?: Record<string, unknown> }>;
    texts?: Array<{ name?: string }>;
    processing?: Array<{ attributes?: Record<string, unknown> }>;
  };
  const mediumCfg = (pkg.configuration as { medium?: Array<Record<string, unknown>> })
    ?.medium;
  if (mediumCfg?.length) {
    for (const m of mediumCfg.slice(0, 3)) {
      lines.push(
        `- Als Verarbeitungsmedium ist NACHA=${m.medium_code} mit der Bedeutung „${m.medium_text}“ hinterlegt.`,
      );
    }
  }
  lines.push(
    JSON.stringify(
      {
        output_types: (idoc.output_types ?? []).slice(0, 4),
        texts: (idoc.texts ?? []).slice(0, 4),
        processing: (idoc.processing ?? []).slice(0, 4),
      },
      null,
      2,
    ).slice(0, compact ? 2500 : 6000),
  );
  lines.push("");
  lines.push("## Code units");
  lines.push(
    JSON.stringify(pkg.code_units.slice(0, compact ? 10 : 25), null, 2).slice(
      0,
      compact ? 2000 : 5000,
    ),
  );
  lines.push("");
  lines.push("## Call chains (aufgelöst)");
  lines.push(
    JSON.stringify(pkg.call_chains.slice(0, compact ? 10 : 25), null, 2).slice(
      0,
      compact ? 2000 : 4000,
    ),
  );
  if (!compact) {
    lines.push("");
    lines.push("## Table accesses");
    lines.push(
      JSON.stringify(pkg.table_accesses.slice(0, 20), null, 2).slice(0, 3000),
    );
  }
  lines.push("");
  lines.push("## Technisch offen / Lücken");
  for (const q of pkg.open_questions.slice(0, compact ? 8 : 20)) {
    lines.push(`- ${q}`);
  }
  lines.push("");
  lines.push(
    [
      "Rules:",
      "- Use only proven claims as confirmed facts.",
      "- Never present endpoints named '?' or unresolved relations as confirmed.",
      "- Medium: say e.g. „Als Verarbeitungsmedium ist NACHA=8 mit der Bedeutung ‚Spezialfunktion‘ hinterlegt.“",
      "- Do NOT say GENERIC_SAP_MAPPING is a business function; that is only a technical resolution source for the medium text (omit from process answer).",
      "- Do not invent SAP object names. Mark gaps explicitly.",
    ].join(" "),
  );
  return lines.join("\n");
}
