/**
 * Resolve TNAPR PGNAM → PROGRAM and RONAM → FORM_ROUTINE within that program.
 * Deterministic — never invents assignments.
 */
import { existsSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  asString,
  streamJsonlObjectsMatching,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import type {
  EvidenceGraphEdge,
  EvidenceGraphNode,
  RelationResolution,
} from "./types";

export type TnaprResolution = {
  output_type_id: string | null;
  processing_id: string | null;
  program_name: string;
  routine_name: string | null;
  program_resolved: boolean;
  routine_resolved: boolean;
  program_source_path: string | null;
  routine_source_path: string | null;
  unresolved_reasons: string[];
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
};

type TargetedLookup = {
  programResolved: boolean;
  routineResolved: boolean;
  programPath: string | null;
  routinePath: string | null;
};

/** Per-process cache for repeated PGNAM/RONAM lookups in one run. */
const lookupCache = new Map<string, TargetedLookup>();

async function lookupProgramRoutine(
  projectKey: string,
  programName: string,
  routineName: string | null,
): Promise<TargetedLookup> {
  const progU = programName.toUpperCase();
  const formU = routineName?.toUpperCase() || null;
  const cacheKey = `${projectKey}|${progU}|${formU ?? ""}`;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached;

  let programResolved = false;
  let routineResolved = false;
  let programPath: string | null = null;
  let routinePath: string | null = null;

  const sourceObjects = resolveProjectZonePath(
    projectKey,
    "canonical",
    "programs",
    "source_objects.jsonl",
  );
  if (existsSync(sourceObjects)) {
    for await (const rec of streamJsonlObjectsMatching(sourceObjects, [progU])) {
      const objectName = (
        asString(rec.object_name) ||
        asString(rec.program) ||
        ""
      ).toUpperCase();
      if (objectName === progU) {
        programResolved = true;
        programPath = "canonical/programs/source_objects.jsonl";
        break;
      }
    }
  }

  const extracts = resolveProjectZonePath(
    projectKey,
    "canonical",
    "programs",
    "extracts.jsonl",
  );
  const codeUnits = resolveProjectZonePath(
    projectKey,
    "canonical",
    "programs",
    "code_units.jsonl",
  );

  const scanUnits = async (pathHint: string, abs: string) => {
    if (!existsSync(abs)) return;
    for await (const rec of streamJsonlObjectsMatching(abs, [progU])) {
      const objectName = (
        asString(rec.object_name) ||
        asString(rec.program) ||
        asString(rec.source_object) ||
        ""
      ).toUpperCase();
      if (objectName !== progU) continue;
      programResolved = true;
      if (!programPath) programPath = pathHint;

      if (!formU) continue;
      const unitType = (
        asString(rec.unit_type) ||
        asString(rec.object_type) ||
        ""
      ).toUpperCase();
      const unitName = (
        asString(rec.unit_name) ||
        asString(rec.form_name) ||
        asString(rec.name) ||
        ""
      ).toUpperCase();
      if (
        unitName === formU &&
        (unitType === "FORM" ||
          unitType === "FORM_ROUTINE" ||
          unitType.includes("FORM"))
      ) {
        routineResolved = true;
        routinePath = pathHint;
        return;
      }
    }
  };

  // Prefer extracts; stop early once form is found
  await scanUnits("canonical/programs/extracts.jsonl", extracts);
  if (formU && !routineResolved) {
    await scanUnits("canonical/programs/code_units.jsonl", codeUnits);
  }

  const result: TargetedLookup = {
    programResolved,
    routineResolved: formU ? routineResolved : false,
    programPath,
    routinePath,
  };
  lookupCache.set(cacheKey, result);
  return result;
}

function nodeId(type: string, name: string): string {
  return `node:${type}:${name}`;
}

/**
 * Resolve one TNAPR processing row (PGNAM + optional RONAM) against canonical programs.
 */
export async function resolveTnaprProgramRoutine(params: {
  projectKey: string;
  programName: string;
  routineName?: string | null;
  outputTypeId?: string | null;
  processingId?: string | null;
}): Promise<TnaprResolution> {
  const programName = params.programName.trim();
  const routineName = params.routineName?.trim() || null;
  const unresolved: string[] = [];
  const nodes: EvidenceGraphNode[] = [];
  const edges: EvidenceGraphEdge[] = [];

  const empty: TnaprResolution = {
    output_type_id: params.outputTypeId ?? null,
    processing_id: params.processingId ?? null,
    program_name: programName,
    routine_name: routineName,
    program_resolved: false,
    routine_resolved: false,
    program_source_path: null,
    routine_source_path: null,
    unresolved_reasons: unresolved,
    nodes,
    edges,
  };

  if (!programName) {
    unresolved.push("PGNAM empty");
    return empty;
  }

  const lookup = await lookupProgramRoutine(
    params.projectKey,
    programName,
    routineName,
  );
  const programResolved = lookup.programResolved;

  const progNode: EvidenceGraphNode = {
    id: nodeId("PROGRAM", programName),
    type: "PROGRAM",
    name: programName,
    source: "tnapr_resolution",
    source_path: programResolved
      ? lookup.programPath ?? "canonical/programs/extracts.jsonl"
      : "unresolved",
    exact_match: true,
    score: programResolved ? 0.99 : 0.4,
    attributes: {
      resolution: programResolved ? "RESOLVED_STATIC" : "DYNAMIC_UNRESOLVED",
      via: "TNAPR.PGNAM",
    },
  };
  nodes.push(progNode);

  if (!programResolved) {
    unresolved.push(`PROGRAM ${programName} not found in canonical/programs`);
  }

  if (params.outputTypeId) {
    const fromId = nodeId("OUTPUT_TYPE", params.outputTypeId);
    nodes.push({
      id: fromId,
      type: "OUTPUT_TYPE",
      name: params.outputTypeId,
      source: "tnapr_resolution",
      source_path: "canonical/message-idoc-config/objects.jsonl",
      exact_match: true,
      score: 0.99,
      attributes: {},
    });
    edges.push({
      from: fromId,
      relation: "OUTPUT_TYPE_PROCESSED_BY_PROGRAM",
      to: progNode.id,
      resolution: programResolved ? "RESOLVED_STATIC" : "DYNAMIC_UNRESOLVED",
      evidence: [
        `TNAPR.PGNAM=${programName}`,
        programResolved
          ? "program found in canonical"
          : "program missing in canonical",
      ],
      confidence: programResolved ? 0.98 : 0.35,
    });
  }

  let routineResolved = false;
  let routinePath: string | null = null;

  if (routineName) {
    routineResolved = lookup.routineResolved;
    routinePath = lookup.routinePath;

    const formNode: EvidenceGraphNode = {
      id: nodeId("FORM_ROUTINE", `${programName}.${routineName}`),
      type: "FORM_ROUTINE",
      name: routineName,
      source: "tnapr_resolution",
      source_path: routinePath ?? "unresolved",
      exact_match: true,
      score: routineResolved ? 0.98 : 0.35,
      attributes: {
        program: programName,
        via: "TNAPR.RONAM",
        resolution: routineResolved ? "RESOLVED_STATIC" : "DYNAMIC_UNRESOLVED",
      },
    };
    nodes.push(formNode);

    if (routineResolved) {
      edges.push({
        from: progNode.id,
        relation: "PROGRAM_CONTAINS_FORM_ROUTINE",
        to: formNode.id,
        resolution: "RESOLVED_STATIC",
        evidence: [`FORM ${routineName} in ${programName}`],
        confidence: 0.97,
      });
    } else {
      unresolved.push(
        `FORM_ROUTINE ${routineName} not found in program ${programName} (or its units)`,
      );
    }

    if (params.outputTypeId) {
      const fromId = nodeId("OUTPUT_TYPE", params.outputTypeId);
      edges.push({
        from: fromId,
        relation: "OUTPUT_TYPE_USES_ROUTINE",
        to: formNode.id,
        resolution: (routineResolved
          ? "RESOLVED_STATIC"
          : "DYNAMIC_UNRESOLVED") as RelationResolution,
        evidence: [
          `TNAPR.RONAM=${routineName}`,
          routineResolved
            ? "form found in program units"
            : "form not found — unresolved relation kept",
        ],
        confidence: routineResolved ? 0.97 : 0.3,
      });
    }
  }

  return {
    output_type_id: params.outputTypeId ?? null,
    processing_id: params.processingId ?? null,
    program_name: programName,
    routine_name: routineName,
    program_resolved: programResolved,
    routine_resolved: routineResolved,
    program_source_path: programResolved
      ? lookup.programPath ?? "canonical/programs/extracts.jsonl"
      : null,
    routine_source_path: routinePath,
    unresolved_reasons: unresolved,
    nodes,
    edges,
  };
}

/**
 * Resolve all output_processing hits from an anchor inventory / message-idoc objects
 * that carry PGNAM (and optional RONAM).
 */
export async function resolveTnaprFromProcessingHits(params: {
  projectKey: string;
  hits: Array<{
    object_id?: string;
    name?: string;
    type?: string;
    attributes?: Record<string, unknown>;
  }>;
}): Promise<{
  resolutions: TnaprResolution[];
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
}> {
  const resolutions: TnaprResolution[] = [];
  const nodes: EvidenceGraphNode[] = [];
  const edges: EvidenceGraphEdge[] = [];
  const seen = new Set<string>();

  for (const hit of params.hits) {
    const attrs = hit.attributes ?? {};
    const pgnam = typeof attrs.PGNAM === "string" ? attrs.PGNAM.trim() : "";
    if (!pgnam) continue;
    const ronam = typeof attrs.RONAM === "string" ? attrs.RONAM.trim() : null;
    const kschl = typeof attrs.KSCHL === "string" ? attrs.KSCHL : null;
    const kappl = typeof attrs.KAPPL === "string" ? attrs.KAPPL : null;
    const nacha = typeof attrs.NACHA === "string" ? attrs.NACHA : null;
    const processingId = hit.object_id ?? null;
    // Soft output type id B|KAPPL|KSCHL when available
    const outputTypeId =
      kappl && kschl ? `B|${kappl}|${kschl}` : kschl ? kschl : null;

    const dedupe = `${pgnam}|${ronam ?? ""}|${outputTypeId ?? ""}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const res = await resolveTnaprProgramRoutine({
      projectKey: params.projectKey,
      programName: pgnam,
      routineName: ronam,
      outputTypeId,
      processingId,
    });
    // Attach medium code on program node attrs for downstream medium resolve
    if (nacha) {
      for (const n of res.nodes) {
        if (n.type === "OUTPUT_TYPE" || n.type === "PROGRAM") {
          n.attributes = { ...n.attributes, NACHA: nacha };
        }
      }
    }
    resolutions.push(res);
    nodes.push(...res.nodes);
    edges.push(...res.edges);
  }

  return { resolutions, nodes, edges };
}
