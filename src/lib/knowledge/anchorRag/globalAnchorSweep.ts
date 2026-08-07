/**
 * Global Anchor Sweep — exact + technical substring across all corpora.
 * Produces AnchorInventory per technical token. No symbol-specific rules.
 */
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  asString,
  streamJsonlObjects,
  streamJsonlObjectsMatching,
  textMatchesAny,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import {
  extractTechnicalSymbols,
  technicalSymbolNeedles,
} from "@/lib/search/technicalSymbols";
import { mapMessageIdocObjectType } from "./relationCatalog";
import { messageIdocObjectIsAuthoritativeOutputType } from "@/lib/domain/typeAuthority";
import type {
  AnchorHit,
  AnchorHitType,
  AnchorInventory,
  EvidenceGraphNode,
} from "./types";
import { ANCHOR_HIT_TYPES } from "./types";

const MASTER_DOMAINS = ["materials", "customers", "vendors"] as const;

function emptyHitsByType(): Record<AnchorHitType, number> {
  return Object.fromEntries(ANCHOR_HIT_TYPES.map((t) => [t, 0])) as Record<
    AnchorHitType,
    number
  >;
}

function bump(
  inv: AnchorInventory,
  hit: AnchorHit,
  maxHits: number,
): void {
  inv.hits_by_type[hit.type] = (inv.hits_by_type[hit.type] ?? 0) + 1;
  if (inv.hits.length < maxHits) inv.hits.push(hit);
}

function msgidocHitType(objectType: string): AnchorHitType {
  const n = mapMessageIdocObjectType(objectType);
  if (n === "OUTPUT_TYPE") return "OUTPUT_TYPE";
  if (n === "OUTPUT_TYPE_TEXT") return "OUTPUT_TYPE_TEXT";
  if (n === "OUTPUT_PROCESSING") return "OUTPUT_PROCESSING";
  if (n === "MESSAGE_TYPE") return "MESSAGE_TYPE";
  if (n === "IDOC_TYPE" || n === "IDOC_EXTENSION" || n === "IDOC_SEGMENT")
    return "IDOC_TYPE";
  if (n === "PARTNER_PROFILE") return "PARTNER_PROFILE";
  if (n === "PROCESS_CODE") return "PROCESS_CODE";
  if (n === "PORT") return "PORT";
  return "OTHER";
}

function nodeFromHit(hit: AnchorHit, anchor: string): EvidenceGraphNode {
  const graphType: EvidenceGraphNode["type"] =
    hit.type === "OTHER" ? "TECHNICAL_SYMBOL" : (hit.type as EvidenceGraphNode["type"]);
  return {
    id: `node:${graphType}:${hit.object_id || hit.name}`,
    type: graphType,
    name: hit.name,
    source: "global_anchor_sweep",
    source_path: hit.source_path,
    exact_match: hit.exact_match,
    score: hit.score,
    attributes: {
      anchor,
      ...(hit.attributes ?? {}),
      summary: hit.summary,
    },
  };
}

export type GlobalAnchorSweepResult = {
  anchors: string[];
  inventories: AnchorInventory[];
  nodes: EvidenceGraphNode[];
  duration_ms: number;
  /** Canonical / analysis records examined during the sweep. */
  documents_scanned: number;
};

export async function runGlobalAnchorSweep(params: {
  projectKey: string;
  question: string;
  /** Optional explicit anchors; otherwise extracted from question. */
  anchors?: string[];
  maxHitsPerAnchor?: number;
  /**
   * Exact-symbol fast path: message-idoc + targeted code name matches.
   * Skips control-table rows and master-data structure scans.
   */
  focused?: boolean;
}): Promise<GlobalAnchorSweepResult> {
  const started = Date.now();
  const focused = params.focused === true;
  const maxHits = params.maxHitsPerAnchor ?? (focused ? 36 : 80);
  const symbols = extractTechnicalSymbols(params.question);
  const anchors =
    params.anchors && params.anchors.length > 0
      ? [...new Set(params.anchors.map((a) => a.trim()).filter(Boolean))]
      : [
          ...new Set(
            technicalSymbolNeedles(symbols).filter((n) => n.length >= 2),
          ),
        ];

  const inventories: AnchorInventory[] = [];
  const nodes: EvidenceGraphNode[] = [];
  const nodeSeen = new Set<string>();
  let documentsScanned = 0;

  for (const anchor of anchors) {
    const needles = [anchor];
    const inv: AnchorInventory = {
      anchor,
      hits_by_type: emptyHitsByType(),
      hits: [],
    };

    // MESSAGE_IDOC first — config must not be crowded out by code hit budget
    const msgPathEarly = resolveProjectZonePath(
      params.projectKey,
      "canonical",
      "message-idoc-config",
      "objects.jsonl",
    );
    if (existsSync(msgPathEarly)) {
      const msgStream = focused
        ? streamJsonlObjectsMatching(msgPathEarly, needles)
        : streamJsonlObjects(msgPathEarly);
      for await (const rec of msgStream) {
        documentsScanned += 1;
        const objectType = asString(rec.object_type);
        const objectId = asString(rec.object_id);
        const display = asString(rec.display_name);
        const attrs =
          rec.attributes && typeof rec.attributes === "object"
            ? (rec.attributes as Record<string, unknown>)
            : {};
        const blob = `${objectType} ${objectId} ${display} ${Object.values(attrs).join(" ")}`;
        if (!textMatchesAny(blob, needles)) continue;
        // Defense in depth: never surface non-B T685 rows as OUTPUT_TYPE existence
        if (
          (objectType === "output_type" || objectType === "output_type_text") &&
          !messageIdocObjectIsAuthoritativeOutputType({
            object_type: objectType,
            attributes: attrs,
          })
        ) {
          continue;
        }
        const exact =
          Object.values(attrs).some(
            (v) => String(v).toUpperCase() === anchor.toUpperCase(),
          ) ||
          display.toUpperCase() === anchor.toUpperCase() ||
          objectId.toUpperCase().includes(anchor.toUpperCase());
        bump(
          inv,
          {
            type: msgidocHitType(objectType),
            name: display || objectId,
            object_id: objectId,
            source_path: "canonical/message-idoc-config/objects.jsonl",
            exact_match: exact,
            score: exact ? 0.99 : 0.9,
            summary: `${objectType} ${objectId}`,
            attributes: {
              object_type: objectType,
              existence_relation: "OBJECT_EXISTS_AS_TYPE",
              ...attrs,
            },
          },
          maxHits,
        );
      }
    }

    // Exact config found: still collect related code via line-prefiltered scan (no full parse).
    const exactConfigAnchor =
      focused &&
      inv.hits.some(
        (h) =>
          h.exact_match &&
          (h.type === "OUTPUT_TYPE" ||
            h.type === "OUTPUT_PROCESSING" ||
            h.type === "OUTPUT_TYPE_TEXT" ||
            h.type === "MESSAGE_TYPE" ||
            h.type === "IDOC_TYPE" ||
            h.type === "PARTNER_PROFILE" ||
            h.type === "PROCESS_CODE"),
      );

    // Programs extracts
    const progExtract = resolveProjectZonePath(
      params.projectKey,
      "canonical",
      "programs",
      "extracts.jsonl",
    );
    if (existsSync(progExtract)) {
      let addedCode = 0;
      const codeBudget = focused ? 14 : maxHits;
      const seenObjects = new Set<string>();
      const progStream =
        focused || exactConfigAnchor
          ? streamJsonlObjectsMatching(progExtract, needles)
          : streamJsonlObjects(progExtract);
      let n = 0;
      const progCap = 80_000;
      // Pass 1 buffer for focused: collect candidates then prefer PROGRAM rows / unique objects
      const focusedCandidates: Array<{
        type: AnchorHitType;
        name: string;
        object_id: string;
        exact: boolean;
        summary: string;
        attributes?: Record<string, unknown>;
        rank: number;
      }> = [];
      for await (const rec of progStream) {
        documentsScanned += 1;
        if (n++ > progCap) break;
        const objectName = asString(rec.object_name) || asString(rec.program);
        const unitName = asString(rec.unit_name) || asString(rec.form_name);
        const unitType = (asString(rec.unit_type) || "").toUpperCase();
        const nameBlob = `${objectName} ${unitName}`;
        if (focused) {
          const bodyHit =
            exactConfigAnchor &&
            textMatchesAny(JSON.stringify(rec).slice(0, 1500), needles);
          if (!textMatchesAny(nameBlob, needles) && !bodyHit) continue;
        } else {
          const blob = `${nameBlob} ${JSON.stringify(rec).slice(0, 2000)}`;
          if (!textMatchesAny(blob, needles)) continue;
        }
        const exact =
          objectName.toUpperCase() === anchor.toUpperCase() ||
          unitName.toUpperCase() === anchor.toUpperCase() ||
          objectName.toUpperCase().includes(anchor.toUpperCase());
        let type: AnchorHitType = "PROGRAM";
        if (unitType === "FORM" || unitType.includes("FORM")) type = "FORM_ROUTINE";
        else if (unitType === "INCLUDE") type = "INCLUDE";
        const attrs = {
          tables_read: Array.isArray(rec.tables_read)
            ? (rec.tables_read as string[]).slice(0, 12)
            : undefined,
          call_function: Array.isArray(rec.call_function)
            ? (rec.call_function as string[]).slice(0, 12)
            : undefined,
        };
        if (focused) {
          const objU = objectName.toUpperCase();
          const rank =
            (unitType === "PROGRAM" || unitType === "FULL_PROGRAM" ? 0 : 2) +
            (objU.includes(anchor.toUpperCase()) ? 0 : 1) +
            (type === "FORM_ROUTINE" && !unitName.toUpperCase().includes(anchor.toUpperCase())
              ? 3
              : 0);
          focusedCandidates.push({
            type,
            name: unitName || objectName,
            object_id: objectName,
            exact,
            summary: `${type} ${objectName} · ${unitName}`.slice(0, 200),
            attributes: attrs,
            rank,
          });
          if (focusedCandidates.length >= 80) break;
          continue;
        }
        bump(
          inv,
          {
            type,
            name: unitName || objectName,
            object_id: objectName,
            source_path: "canonical/programs/extracts.jsonl",
            exact_match: exact,
            score: exact ? 0.99 : 0.85,
            summary: `${type} ${objectName} · ${unitName}`.slice(0, 200),
            attributes: attrs,
          },
          maxHits,
        );
        addedCode += 1;
        if (addedCode >= codeBudget) break;
      }
      if (focused && focusedCandidates.length) {
        focusedCandidates.sort((a, b) => a.rank - b.rank);
        for (const c of focusedCandidates) {
          const key = `${c.type}|${c.object_id}|${c.name}`;
          const objKey = c.object_id.toUpperCase();
          // Keep at most 2 hits per program object (prefer PROGRAM + one FORM with anchor)
          const objCount = [...seenObjects].filter((s) => s.startsWith(`${objKey}|`)).length;
          if (objCount >= 2) continue;
          seenObjects.add(`${objKey}|${c.name}`);
          if (seenObjects.has(key)) continue;
          bump(
            inv,
            {
              type: c.type,
              name: c.name,
              object_id: c.object_id,
              source_path: "canonical/programs/extracts.jsonl",
              exact_match: c.exact,
              score: c.exact ? 0.99 : 0.85,
              summary: c.summary,
              attributes: c.attributes,
            },
            maxHits,
          );
          addedCode += 1;
          if (addedCode >= codeBudget) break;
        }
      }
    }

    // Function modules extracts
    const fmExtract = resolveProjectZonePath(
      params.projectKey,
      "canonical",
      "function-modules",
      "extracts.jsonl",
    );
    if (existsSync(fmExtract)) {
      let addedFm = 0;
      const fmBudget = focused ? 6 : maxHits;
      const fmStream =
        focused || exactConfigAnchor
          ? streamJsonlObjectsMatching(fmExtract, needles)
          : streamJsonlObjects(fmExtract);
      let n = 0;
      const fmCap = focused ? 40_000 : 40_000;
      for await (const rec of fmStream) {
        documentsScanned += 1;
        if (n++ > fmCap) break;
        const objectName =
          asString(rec.object_name) || asString(rec.function_module);
        if (focused) {
          if (!textMatchesAny(objectName, needles)) continue;
        } else {
          const blob = `${objectName} ${JSON.stringify(rec).slice(0, 1500)}`;
          if (!textMatchesAny(blob, needles)) continue;
        }
        const exact = objectName.toUpperCase().includes(anchor.toUpperCase());
        bump(
          inv,
          {
            type: "FUNCTION_MODULE",
            name: objectName,
            object_id: objectName,
            source_path: "canonical/function-modules/extracts.jsonl",
            exact_match: exact,
            score: exact ? 0.99 : 0.85,
            summary: `FUNCTION_MODULE ${objectName}`,
          },
          maxHits,
        );
        addedFm += 1;
        if (focused && addedFm >= fmBudget) break;
        if (focused && inv.hits_by_type.FUNCTION_MODULE >= 8) break;
      }
    }

    // Class code units — focused line-prefilter only (related methods)
    const classUnits = resolveProjectZonePath(
      params.projectKey,
      "canonical",
      "classes",
      "code_units.jsonl",
    );
    if (focused && existsSync(classUnits)) {
      let added = 0;
      for await (const rec of streamJsonlObjectsMatching(classUnits, needles)) {
        documentsScanned += 1;
        const className = asString(rec.class_name) || asString(rec.object_name);
        const methodName = asString(rec.method_name) || asString(rec.unit_name);
        const blob = `${className} ${methodName}`;
        if (!textMatchesAny(blob, needles)) continue;
        bump(
          inv,
          {
            type: "METHOD",
            name: methodName ? `${className}.${methodName}` : className,
            object_id: className,
            source_path: "canonical/classes/code_units.jsonl",
            exact_match: blob.toUpperCase().includes(anchor.toUpperCase()),
            score: 0.9,
            summary: `METHOD ${className}.${methodName}`.slice(0, 200),
            attributes: { class_name: className, method_name: methodName },
          },
          maxHits,
        );
        added += 1;
        if (added >= 6) break;
      }
    }

    // Class analyses (skipped on focused exact-symbol path)
    const analysesPath = resolveProjectZonePath(
      params.projectKey,
      "analyses",
      "classes",
      "unit_analyses.jsonl",
    );
    if (!focused && existsSync(analysesPath)) {
      let n = 0;
      for await (const rec of streamJsonlObjects(analysesPath)) {
        documentsScanned += 1;
        if (n++ > 80_000) break;
        const className = asString(rec.class_name);
        const methodName = asString(rec.method_name);
        const blob = `${className} ${methodName} ${asString(rec.search_text)}`;
        if (!textMatchesAny(blob, needles)) continue;
        const exact =
          className.toUpperCase().includes(anchor.toUpperCase()) ||
          methodName.toUpperCase().includes(anchor.toUpperCase());
        bump(
          inv,
          {
            type: "METHOD",
            name: `${className}.${methodName}`,
            object_id: className,
            source_path: "analyses/classes/unit_analyses.jsonl",
            exact_match: exact,
            score: exact ? 0.99 : 0.9,
            summary: asString(rec.technical_summary).slice(0, 200),
            attributes: { class_name: className, method_name: methodName },
          },
          maxHits,
        );
      }
    }

    // Control tables + master — full path only
    if (!focused) {
      const ctDefs = resolveProjectZonePath(
        params.projectKey,
        "canonical",
        "control-tables",
        "table_definitions.jsonl",
      );
      if (existsSync(ctDefs)) {
        for await (const rec of streamJsonlObjects(ctDefs)) {
          documentsScanned += 1;
          const table = asString(rec.table_name) || asString(rec.name);
          if (!textMatchesAny(table, needles)) continue;
          bump(
            inv,
            {
              type: "CONTROL_TABLE",
              name: table,
              object_id: table,
              source_path: "canonical/control-tables/table_definitions.jsonl",
              exact_match: table.toUpperCase() === anchor.toUpperCase(),
              score: 0.95,
              summary: `CONTROL_TABLE ${table}`,
            },
            maxHits,
          );
        }
      }

      const ctRows = resolveProjectZonePath(
        params.projectKey,
        "canonical",
        "control-tables",
        "table_rows.jsonl",
      );
      if (existsSync(ctRows)) {
        let n = 0;
        for await (const rec of streamJsonlObjects(ctRows)) {
          documentsScanned += 1;
          if (n++ > 120_000) break;
          const table = asString(rec.table_name);
          const pk = asString(rec.primary_key) || asString(rec.row_key);
          const blob = `${table} ${pk} ${JSON.stringify(rec.values ?? rec.fields ?? {}).slice(0, 800)}`;
          if (!textMatchesAny(blob, needles)) continue;
          bump(
            inv,
            {
              type: "CONTROL_TABLE_ROW",
              name: `${table}|${pk}`,
              object_id: `${table}|${pk}`,
              source_path: "canonical/control-tables/table_rows.jsonl",
              exact_match: true,
              score: 0.92,
              summary: `CONTROL_TABLE_ROW ${table} ${pk}`.slice(0, 200),
              attributes: { table_name: table },
            },
            maxHits,
          );
        }
      }

      const mdRoot = resolveProjectZonePath(
        params.projectKey,
        "canonical",
        "master-data",
      );
      if (existsSync(mdRoot)) {
        for (const domain of MASTER_DOMAINS) {
          const domainDir = path.join(mdRoot, domain);
          if (!existsSync(domainDir) || !statSync(domainDir).isDirectory()) continue;
          for (const table of readdirSync(domainDir)) {
            const structurePath = path.join(domainDir, table, "structure.jsonl");
            if (!existsSync(structurePath)) continue;
            for await (const rec of streamJsonlObjects(structurePath)) {
              documentsScanned += 1;
              if (asString(rec.record_type) !== "master_field_definition") continue;
              const field = asString(rec.field_name);
              const tableName = asString(rec.table_name) || table;
              const blob = `${tableName} ${field} ${asString(rec.description)}`;
              if (!textMatchesAny(blob, needles)) continue;
              bump(
                inv,
                {
                  type: "MASTER_DATA_FIELD",
                  name: `${tableName}-${field}`,
                  object_id: `${tableName}.${field}`,
                  source_path: `canonical/master-data/${domain}/${table}/structure.jsonl`,
                  exact_match: field.toUpperCase() === anchor.toUpperCase(),
                  score: 0.95,
                  summary: `FIELD ${tableName}-${field}`,
                },
                maxHits,
              );
            }
          }
        }
      }
    }

    inventories.push(inv);
    for (const hit of inv.hits) {
      const node = nodeFromHit(hit, anchor);
      if (nodeSeen.has(node.id)) continue;
      nodeSeen.add(node.id);
      nodes.push(node);
    }
  }

  return {
    anchors,
    inventories,
    nodes,
    duration_ms: Date.now() - started,
    documents_scanned: documentsScanned,
  };
}
