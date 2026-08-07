/**
 * Anchor-based RAG orchestration (deterministic core).
 * OpenAI only used when enablePlanningRound=true (deep search).
 */
import { randomUUID } from "crypto";
import type { QueryUnderstanding } from "@/lib/knowledge/deepSearch/types";
import { runGlobalAnchorSweep } from "./globalAnchorSweep";
import { expandRelations } from "./relationExpansion";
import {
  buildEvidenceGraph,
  buildEvidencePackage,
  evidencePackageToPromptBlock,
  mergeGraphEdges,
  mergeGraphNodes,
  persistAnchorInventories,
  persistEvidenceGraph,
  persistEvidencePackage,
} from "./evidenceGraph";
import { resolveTnaprFromProcessingHits } from "./resolveTnapr";
import {
  collectPartnerProfilesForAnchors,
  resolvePartnerToMaster,
} from "./resolvePartnerMaster";
import { resolveMedium } from "./mediumMapping";
import type {
  AnchorInventory,
  DeepSearchPlanRound,
  EvidenceGraph,
  EvidencePackage,
} from "./types";
import { ensureWritableDir, writeGeneratedText } from "@/lib/localData/fs";

export type AnchorRagRunResult = {
  run_id: string;
  inventories: AnchorInventory[];
  graph: EvidenceGraph;
  evidence_package: EvidencePackage;
  evidence_prompt_block: string;
  planning_round: DeepSearchPlanRound | null;
  tnapr_resolutions: unknown[];
  partner_resolution: unknown;
  medium_resolutions: unknown[];
  paths: {
    evidence_graph: string;
    evidence_package: string;
    anchor_inventory: string;
  };
  metrics: {
    sweep_ms: number;
    expansion_ms: number;
    planning_tokens: { input: number; output: number };
    focused: boolean;
    documents_touched: number;
    documents_scanned: number;
    inventory_hits: number;
  };
};

function pickPrimaryAnchors(
  inventories: AnchorInventory[],
  questionTokens: string[],
): string[] {
  const ranked = inventories
    .map((inv) => {
      const exact = inv.hits.filter((h) => h.exact_match).length;
      const total = inv.hits.length;
      const weight =
        exact * 10 +
        total +
        (inv.hits_by_type.OUTPUT_TYPE ?? 0) * 5 +
        (inv.hits_by_type.PROGRAM ?? 0) * 2 +
        (inv.hits_by_type.FUNCTION_MODULE ?? 0) * 2 +
        (inv.hits_by_type.METHOD ?? 0);
      return { anchor: inv.anchor, weight, exact };
    })
    .sort((a, b) => b.weight - a.weight);

  const primaries = ranked.filter((r) => r.weight > 0).map((r) => r.anchor);
  if (primaries.length > 0) return primaries.slice(0, 5);
  return questionTokens.slice(0, 5);
}

function collectExpansionSeeds(
  inventories: AnchorInventory[],
  primaryAnchors: string[],
  opts?: { focused?: boolean },
): string[] {
  const seeds = new Set<string>(primaryAnchors);
  const focused = opts?.focused === true;
  /** Too generic to expand (application/medium/client codes / common forms). */
  const blocked = new Set(
    [
      "B",
      "V1",
      "V2",
      "V3",
      "V4",
      "E1",
      "A",
      "1",
      "2",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "DE",
      "EN",
      "ENTRY",
      "ENTRY_V1",
      "ENTRY_V2",
      "MAIN",
      "START",
      "INIT",
      "FORM",
      "TOP",
    ].map((s) => s.toUpperCase()),
  );

  const allow = (s: string): boolean => {
    const t = s.trim();
    if (t.length < 3) return false;
    if (blocked.has(t.toUpperCase())) return false;
    // Focused: only keep tokens that relate to a primary anchor or look like Z/Y objects
    if (focused) {
      const u = t.toUpperCase();
      const hitPrimary = primaryAnchors.some(
        (a) =>
          u === a.toUpperCase() ||
          u.includes(a.toUpperCase()) ||
          a.toUpperCase().includes(u),
      );
      if (hitPrimary) return true;
      if (/^[ZY]/i.test(t) && t.length >= 4) return true;
      // compound config ids that contain primary
      if (t.includes("|") && hitPrimary) return true;
      return false;
    }
    return true;
  };

  for (const inv of inventories) {
    if (!primaryAnchors.includes(inv.anchor)) continue;
    for (const hit of inv.hits.slice(0, focused ? 20 : 40)) {
      if (hit.object_id && allow(hit.object_id)) seeds.add(hit.object_id);
      if (hit.name && allow(hit.name)) seeds.add(hit.name);
      const attrs = hit.attributes ?? {};
      // Prefer processing targets; never expand bare KAPPL/NACHA/KVEWE/RONAM
      for (const k of ["PGNAM", "KSCHL", "MSGTYP", "MESTYP", "IDOCTYP"]) {
        const v = attrs[k];
        if (typeof v === "string" && allow(v.trim())) seeds.add(v.trim());
      }
    }
  }
  return [...seeds].filter(allow).slice(0, focused ? 24 : 60);
}

export async function runAnchorRag(params: {
  projectKey: string;
  question: string;
  queryUnderstanding?: QueryUnderstanding | null;
  enablePlanningRound?: boolean;
  maxHops?: number;
  runId?: string;
  /**
   * Exact-symbol fast path for direct_rag: focused sweep/expansion,
   * compact evidence package, no deep planning.
   */
  focused?: boolean;
}): Promise<AnchorRagRunResult> {
  const runId =
    params.runId ??
    `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23)}_${randomUUID().slice(0, 8)}`;
  const focused = params.focused === true;

  const technicalTokens =
    params.queryUnderstanding?.technical_tokens?.filter(Boolean) ?? [];

  const sweep = await runGlobalAnchorSweep({
    projectKey: params.projectKey,
    question: params.question,
    anchors: technicalTokens.length > 0 ? technicalTokens : undefined,
    focused,
    maxHitsPerAnchor: focused ? 36 : 80,
  });

  const primaryAnchors = pickPrimaryAnchors(sweep.inventories, [
    ...technicalTokens,
    ...sweep.anchors,
  ]);

  // --- TNAPR program/routine resolution ---
  const processingHits = sweep.inventories.flatMap((inv) =>
    inv.hits.filter(
      (h) =>
        (h.type === "OUTPUT_TYPE" || h.type === "OUTPUT_PROCESSING") &&
        (h.attributes?.PGNAM ||
          String(h.summary ?? "").includes("output_processing") ||
          h.object_id?.includes("|")),
    ),
  );
  // Prefer hits that actually carry PGNAM (output_processing objects)
  const withPgnam = sweep.inventories.flatMap((inv) =>
    inv.hits.filter((h) => typeof h.attributes?.PGNAM === "string"),
  );
  const tnapr = await resolveTnaprFromProcessingHits({
    projectKey: params.projectKey,
    hits: (withPgnam.length ? withPgnam : processingHits).map((h) => ({
      object_id: h.object_id,
      name: h.name,
      type: h.type,
      attributes: h.attributes,
    })),
  });

  // Medium resolutions from NACHA on processing hits
  const medium_resolutions = [];
  const seenMedium = new Set<string>();
  for (const h of withPgnam) {
    const code = String(h.attributes?.NACHA ?? "").trim();
    if (!code || seenMedium.has(code)) continue;
    seenMedium.add(code);
    const med = resolveMedium(code);
    medium_resolutions.push({
      ...med,
      output_hint: h.object_id,
      kschl: h.attributes?.KSCHL,
    });
    // Attach OUTPUT_TYPE_USES_MEDIUM edge when we have output type
    const kappl = h.attributes?.KAPPL;
    const kschl = h.attributes?.KSCHL;
    if (typeof kappl === "string" && typeof kschl === "string") {
      const otId = `B|${kappl}|${kschl}`;
      tnapr.nodes.push({
        id: `node:OUTPUT_TYPE:${otId}`,
        type: "OUTPUT_TYPE",
        name: kschl,
        source: "medium_resolution",
        source_path: "canonical/message-idoc-config/objects.jsonl",
        exact_match: true,
        score: 0.99,
        attributes: { NACHA: code, medium: med },
      });
      tnapr.edges.push({
        from: `node:OUTPUT_TYPE:${otId}`,
        relation: "OUTPUT_TYPE_USES_MEDIUM",
        to: `node:TECHNICAL_SYMBOL:NACHA:${code}`,
        resolution:
          med.resolution === "UNRESOLVED" ? "DYNAMIC_UNRESOLVED" : "RESOLVED_BY_TYPE",
        evidence: [
          `NACHA=${code}`,
          `text=${med.medium_text}`,
          `via=${med.resolution}`,
          med.source,
        ],
        confidence: med.resolution === "UNRESOLVED" ? 0.2 : 0.95,
      });
      tnapr.nodes.push({
        id: `node:TECHNICAL_SYMBOL:NACHA:${code}`,
        type: "TECHNICAL_SYMBOL",
        name: `NACHA=${code}`,
        source: "medium_resolution",
        source_path: med.source,
        exact_match: true,
        score: 0.9,
        attributes: { ...med },
      });
    }
  }

  // --- Partner → master (optional on focused path) ---
  let partner_resolution = {
    matches: [] as Awaited<ReturnType<typeof resolvePartnerToMaster>>["matches"],
    unresolved: [] as Awaited<
      ReturnType<typeof resolvePartnerToMaster>
    >["unresolved"],
    ambiguous: [] as Awaited<
      ReturnType<typeof resolvePartnerToMaster>
    >["ambiguous"],
    nodes: [] as Awaited<ReturnType<typeof resolvePartnerToMaster>>["nodes"],
    edges: [] as Awaited<ReturnType<typeof resolvePartnerToMaster>>["edges"],
  };
  if (!focused || sweep.inventories.some((i) => (i.hits_by_type.PARTNER_PROFILE ?? 0) > 0)) {
    const partnerObjs = await collectPartnerProfilesForAnchors({
      projectKey: params.projectKey,
      anchors: primaryAnchors,
      maxPartners: focused ? 20 : 60,
    });
    partner_resolution = await resolvePartnerToMaster({
      projectKey: params.projectKey,
      partners: partnerObjs.map((p) => ({
        object_id: p.object_id,
        attributes: p.attributes,
      })),
    });
  }

  const seeds = collectExpansionSeeds(sweep.inventories, primaryAnchors, {
    focused,
  });
  // Add resolved program names as expansion seeds (not bare RONAM — too generic)
  for (const r of tnapr.resolutions) {
    const rr = r as { program_name?: string; routine_name?: string | null };
    if (rr.program_name) seeds.push(rr.program_name);
  }

  const tnaprComplete =
    focused &&
    tnapr.resolutions.length > 0 &&
    tnapr.resolutions.every((r) => {
      const rr = r as {
        program_resolved: boolean;
        routine_name: string | null;
        routine_resolved: boolean;
      };
      return (
        rr.program_resolved &&
        (!rr.routine_name || rr.routine_resolved)
      );
    });

  // Focused expansion seeds: primary + resolved programs + related code object names
  const focusedSeeds = [
    ...new Set([
      ...primaryAnchors,
      ...tnapr.resolutions
        .map((r) => (r as { program_name?: string }).program_name)
        .filter((x): x is string => Boolean(x)),
      ...sweep.inventories.flatMap((inv) =>
        inv.hits
          .filter(
            (h) =>
              h.type === "PROGRAM" ||
              h.type === "FUNCTION_MODULE" ||
              h.type === "FORM_ROUTINE" ||
              h.type === "METHOD",
          )
          .map((h) => h.object_id || h.name)
          .filter((x): x is string => Boolean(x && x.length >= 4)),
      ),
    ]),
  ].slice(0, 16);

  const expansion = await expandRelations({
    projectKey: params.projectKey,
    seeds: focused ? focusedSeeds : [...new Set(seeds)],
    // When TNAPR already resolved, one hop is enough for related call edges
    maxHops: focused ? (tnaprComplete ? 1 : 2) : (params.maxHops ?? 2),
    maxEdgesPerHop: focused ? 32 : 400,
    focused,
  });

  let nodes = mergeGraphNodes(
    sweep.nodes,
    tnapr.nodes,
    partner_resolution.nodes,
    expansion.nodes,
  );
  let edges = mergeGraphEdges(
    tnapr.edges,
    partner_resolution.edges,
    expansion.edges,
  );
  let planning: DeepSearchPlanRound | null = null;
  let planningTokens = { input: 0, output: 0 };

  if (params.enablePlanningRound && params.queryUnderstanding) {
    const draftGraph = buildEvidenceGraph({
      question: params.question,
      primaryAnchors,
      nodes,
      edges,
    });
    const draftPkg = buildEvidencePackage({
      question: params.question,
      graph: draftGraph,
      inventories: sweep.inventories,
    });
    try {
      const { runDeepSearchPlanningRound } = await import("./planningRound");
      const round = await runDeepSearchPlanningRound({
        question: params.question,
        queryUnderstanding: params.queryUnderstanding,
        graph: draftGraph,
        availableSourceTypes: [
          "programs",
          "function_modules",
          "classes",
          "message_idoc_config",
          "control_tables",
          "master_data",
        ],
        openQuestions: draftPkg.open_questions,
      });
      planning = round.plan;
      planningTokens = round.tokens;

      const nextAnchors = round.plan.next_anchor_queries
        .map((q) => q.anchor)
        .filter(Boolean)
        .slice(0, 8);
      if (nextAnchors.length > 0 && !round.plan.answerable_now) {
        const second = await expandRelations({
          projectKey: params.projectKey,
          seeds: [...seeds, ...nextAnchors],
          maxHops: 2,
          maxEdgesPerHop: focused ? 80 : 400,
          focused,
        });
        nodes = mergeGraphNodes(nodes, second.nodes);
        edges = mergeGraphEdges(edges, second.edges);
      }
    } catch {
      planning = null;
    }
  }

  const graph = buildEvidenceGraph({
    question: params.question,
    primaryAnchors,
    nodes,
    edges,
  });

  const evidence_package = buildEvidencePackage({
    question: params.question,
    graph,
    inventories: sweep.inventories,
    compact: focused,
    maxItems: focused ? 18 : 40,
    sourceCoverage: {
      sweep_ms: sweep.duration_ms,
      expansion_ms: expansion.duration_ms,
      tnapr_resolutions: tnapr.resolutions.length,
      partners_matched: partner_resolution.matches.length,
      partners_unresolved: partner_resolution.unresolved.length,
      focused: focused ? 1 : 0,
      documents_scanned: sweep.documents_scanned,
    },
  });

  // Enrich package configuration with medium + tnapr facts
  evidence_package.configuration = {
    ...evidence_package.configuration,
    medium: medium_resolutions,
    tnapr: tnapr.resolutions.map((r) => ({
      program: (r as { program_name: string }).program_name,
      routine: (r as { routine_name: string | null }).routine_name,
      program_resolved: (r as { program_resolved: boolean }).program_resolved,
      routine_resolved: (r as { routine_resolved: boolean }).routine_resolved,
      unresolved_reasons: (r as { unresolved_reasons: string[] })
        .unresolved_reasons,
    })),
  };
  evidence_package.partners = [
    ...evidence_package.partners,
    ...partner_resolution.matches.map((m) => ({
      partner_id: m.partner_object_id,
      type: m.partner_type,
      number_raw: m.partner_number_raw,
      number_normalized: m.partner_number_normalized,
      matched_key: m.matched_keys[0] ?? null,
      match_kind: m.match_kind,
    })),
  ];
  evidence_package.customers = [
    ...evidence_package.customers,
    ...partner_resolution.matches
      .filter((m) => m.match_kind === "customer")
      .map((m) => ({
        KUNNR: m.matched_keys[0],
        partner_number_raw: m.partner_number_raw,
      })),
  ];
  if (partner_resolution.unresolved.length) {
    evidence_package.open_questions.push(
      `${partner_resolution.unresolved.length} Partnernummern ohne Stammdaten-Treffer.`,
    );
  }
  if (partner_resolution.ambiguous.length) {
    evidence_package.open_questions.push(
      `${partner_resolution.ambiguous.length} Partnernummern mehrdeutig (Kunde/Lieferant).`,
    );
  }
  for (const r of tnapr.resolutions) {
    const rr = r as {
      unresolved_reasons: string[];
      program_name: string;
      routine_name: string | null;
      program_resolved: boolean;
      routine_resolved: boolean;
    };
    for (const reason of rr.unresolved_reasons) {
      evidence_package.open_questions.push(`TNAPR unresolved: ${reason}`);
    }
    if (rr.program_name && rr.program_resolved) {
      evidence_package.proven_claims.unshift(
        `OUTPUT_TYPE processed by PROGRAM ${rr.program_name} (resolved)`,
      );
    } else if (rr.program_name && !rr.program_resolved) {
      evidence_package.open_questions.push(
        `TNAPR: PROGRAM ${rr.program_name} noch nicht im Canonical aufgelöst.`,
      );
    }
    if (rr.routine_name && rr.routine_resolved) {
      evidence_package.proven_claims.unshift(
        `OUTPUT_TYPE uses ROUTINE ${rr.routine_name} (resolved)`,
      );
    } else if (rr.routine_name && !rr.routine_resolved) {
      evidence_package.open_questions.push(
        `TNAPR: ROUTINE ${rr.routine_name} noch nicht im Programm aufgelöst.`,
      );
    }
  }
  for (const h of sweep.inventories.flatMap((i) => i.hits)) {
    if (h.type === "OUTPUT_TYPE_TEXT" && h.exact_match && h.name) {
      evidence_package.proven_claims.unshift(
        `Beschreibung der Outputart: ${h.name}`,
      );
    }
    if (h.type === "OUTPUT_TYPE" && h.exact_match && h.name) {
      evidence_package.proven_claims.unshift(`Outputart ${h.name}`);
    }
  }
  // Related code objects whose names contain a primary anchor (generic, budgeted)
  const relatedCode = sweep.inventories
    .flatMap((i) => i.hits)
    .filter(
      (h) =>
        (h.type === "PROGRAM" ||
          h.type === "FUNCTION_MODULE" ||
          h.type === "METHOD") &&
        primaryAnchors.some((p) =>
          `${h.object_id || ""} ${h.name || ""}`
            .toUpperCase()
            .includes(p.toUpperCase()),
        ),
    )
    .slice(0, focused ? 10 : 16);
  for (const h of relatedCode) {
    evidence_package.proven_claims.splice(
      6,
      0,
      `Verwandtes ${h.type}: ${h.name || h.object_id} (${h.object_id || h.name})`,
    );
  }
  for (const m of medium_resolutions) {
    const mm = m as {
      medium_code: string;
      medium_text: string;
      resolution: string;
    };
    // Fachformulierung — Resolution-Quelle nicht in proven/Prozessantwort
    evidence_package.proven_claims.unshift(
      `Als Verarbeitungsmedium ist NACHA=${mm.medium_code} mit der Bedeutung „${mm.medium_text}“ hinterlegt.`,
    );
  }

  // Safety: never keep placeholder endpoints in proven claims
  evidence_package.proven_claims = [
    ...new Set(
      evidence_package.proven_claims.filter(
        (c) => !c.includes(":?") && !/→\s*\?/.test(c) && !/\?\s*→/.test(c),
      ),
    ),
  ];

  const paths = {
    evidence_graph: persistEvidenceGraph(params.projectKey, runId, graph),
    evidence_package: persistEvidencePackage(
      params.projectKey,
      runId,
      evidence_package,
    ),
    anchor_inventory: persistAnchorInventories(
      params.projectKey,
      runId,
      sweep.inventories,
    ),
  };

  // Persist resolution details for traces
  const rel = `search-runs/${runId}`;
  ensureWritableDir(params.projectKey, "logs", rel);
  writeGeneratedText(
    params.projectKey,
    "logs",
    `${rel}/tnapr-resolution.json`,
    `${JSON.stringify(tnapr.resolutions, null, 2)}\n`,
  );
  writeGeneratedText(
    params.projectKey,
    "logs",
    `${rel}/partner-resolution.json`,
    `${JSON.stringify(
      {
        matches: partner_resolution.matches,
        unresolved: partner_resolution.unresolved,
        ambiguous: partner_resolution.ambiguous,
      },
      null,
      2,
    )}\n`,
  );
  writeGeneratedText(
    params.projectKey,
    "logs",
    `${rel}/medium-resolution.json`,
    `${JSON.stringify(medium_resolutions, null, 2)}\n`,
  );

  return {
    run_id: runId,
    inventories: sweep.inventories,
    graph,
    evidence_package,
    evidence_prompt_block: evidencePackageToPromptBlock(evidence_package, {
      compact: focused,
    }),
    planning_round: planning,
    tnapr_resolutions: tnapr.resolutions,
    partner_resolution: {
      matches: partner_resolution.matches.length,
      unresolved: partner_resolution.unresolved.length,
      ambiguous: partner_resolution.ambiguous.length,
    },
    medium_resolutions,
    paths,
    metrics: {
      sweep_ms: sweep.duration_ms,
      expansion_ms: expansion.duration_ms,
      planning_tokens: planningTokens,
      focused,
      documents_touched: nodes.length,
      documents_scanned: sweep.documents_scanned,
      inventory_hits: sweep.inventories.reduce((n, i) => n + i.hits.length, 0),
    },
  };
}
