/**
 * Deterministic full-corpus inventory for a technical anchor.
 * Generic — no per-symbol special cases. No OpenAI.
 */
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  asString,
  streamJsonlObjectsMatching,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import { mapMessageIdocObjectType } from "@/lib/knowledge/anchorRag/relationCatalog";

export type GroundTruthEntity = {
  type: string;
  id: string;
  name: string;
  source_path: string;
  match: "exact" | "substring";
  attributes?: Record<string, unknown>;
};

export type GroundTruthRelation = {
  from: string;
  from_type?: string;
  relation: string;
  to: string;
  to_type?: string;
  source_path: string;
  match: "exact" | "substring";
};

export type GroundTruthCodeOccurrence = {
  object_type: string;
  object_name: string;
  unit_type?: string;
  unit_name?: string;
  source_path: string;
  tables_read?: string[];
  tables_written?: string[];
  call_function?: string[];
  call_method?: string[];
  perform?: string[];
  match: "exact" | "substring";
};

export type GroundTruthInventory = {
  anchor: string;
  project_key: string;
  generated_at: string;
  entities: GroundTruthEntity[];
  relations: GroundTruthRelation[];
  code_occurrences: GroundTruthCodeOccurrence[];
  configuration_chains: Array<Record<string, unknown>>;
  partner_assignments: Array<Record<string, unknown>>;
  customer_links: Array<Record<string, unknown>>;
  source_paths: string[];
  counts_by_type: Record<string, number>;
  /** Critical entities for technical-symbol / message questions (generic heuristics). */
  critical_entity_ids: string[];
  critical_relation_keys: string[];
};

function matchKind(anchor: string, blob: string): "exact" | "substring" | null {
  const a = anchor.toUpperCase();
  const u = blob.toUpperCase();
  if (!u.includes(a)) return null;
  // Underscore separates SAP technical tokens (Z_PROCESS_MESSAGE_ZECD contains exact ZECD)
  const re = new RegExp(
    `(^|[^A-Z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`,
  );
  if (re.test(u)) return "exact";
  return "substring";
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function pushUniquePath(paths: string[], p: string): void {
  if (!paths.includes(p)) paths.push(p);
}

/**
 * Full mechanical inventory for one technical anchor across canonical (+ analyses).
 */
export async function buildGroundTruthInventory(params: {
  projectKey: string;
  anchor: string;
}): Promise<GroundTruthInventory> {
  const projectKey = params.projectKey;
  const anchor = params.anchor.trim().toUpperCase();
  const needles = [anchor];

  const entities: GroundTruthEntity[] = [];
  const relations: GroundTruthRelation[] = [];
  const code_occurrences: GroundTruthCodeOccurrence[] = [];
  const configuration_chains: Array<Record<string, unknown>> = [];
  const partner_assignments: Array<Record<string, unknown>> = [];
  const customer_links: Array<Record<string, unknown>> = [];
  const source_paths: string[] = [];
  const counts_by_type: Record<string, number> = {};

  const entitySeen = new Set<string>();
  const addEntity = (e: GroundTruthEntity) => {
    const k = `${e.type}|${e.id}`;
    if (entitySeen.has(k)) return;
    entitySeen.add(k);
    entities.push(e);
    bump(counts_by_type, e.type);
    pushUniquePath(source_paths, e.source_path);
  };

  // --- MESSAGE_IDOC ---
  const msgObjects = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
    "objects.jsonl",
  );
  if (existsSync(msgObjects)) {
    const pathHint = "canonical/message-idoc-config/objects.jsonl";
    for await (const rec of streamJsonlObjectsMatching(msgObjects, needles)) {
      const objectType = asString(rec.object_type);
      const objectId = asString(rec.object_id);
      const display = asString(rec.display_name);
      const attrs =
        rec.attributes && typeof rec.attributes === "object"
          ? (rec.attributes as Record<string, unknown>)
          : {};
      const blob = `${objectType} ${objectId} ${display} ${JSON.stringify(attrs)}`;
      const mk = matchKind(anchor, blob);
      if (!mk) continue;
      const graphType = mapMessageIdocObjectType(objectType);
      addEntity({
        type: graphType === "UNKNOWN" ? objectType.toUpperCase() || "CONFIG" : graphType,
        id: objectId || display,
        name: display || objectId,
        source_path: pathHint,
        match: mk,
        attributes: { object_type: objectType, ...attrs },
      });
      if (graphType === "OUTPUT_TYPE" || graphType === "OUTPUT_PROCESSING" || graphType === "OUTPUT_TYPE_TEXT") {
        configuration_chains.push({
          object_type: objectType,
          object_id: objectId,
          display_name: display,
          attributes: attrs,
        });
      }
      if (graphType === "PARTNER_PROFILE") {
        partner_assignments.push({
          object_id: objectId,
          attributes: attrs,
        });
      }
    }
  }

  const msgRels = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
    "relations.jsonl",
  );
  if (existsSync(msgRels)) {
    const pathHint = "canonical/message-idoc-config/relations.jsonl";
    for await (const rec of streamJsonlObjectsMatching(msgRels, needles)) {
      const from =
        asString(rec.from_object_id) ||
        asString(rec.from_name) ||
        asString(rec.from);
      const to =
        asString(rec.to_object_id) || asString(rec.to_name) || asString(rec.to);
      const rel =
        asString(rec.relation_kind) || asString(rec.relation_type) || "RELATED";
      const mk = matchKind(anchor, `${from} ${to} ${rel} ${JSON.stringify(rec)}`);
      if (!mk) continue;
      relations.push({
        from,
        from_type: asString(rec.from_object_type) || asString(rec.from_type),
        relation: rel,
        to,
        to_type: asString(rec.to_object_type) || asString(rec.to_type),
        source_path: pathHint,
        match: mk,
      });
      bump(counts_by_type, `REL:${rel}`);
      pushUniquePath(source_paths, pathHint);
    }
  }

  // --- Programs / FMs / Classes code units ---
  const codeCorpora: Array<{
    abs: string;
    pathHint: string;
    defaultType: string;
  }> = [
    {
      abs: resolveProjectZonePath(projectKey, "canonical", "programs", "extracts.jsonl"),
      pathHint: "canonical/programs/extracts.jsonl",
      defaultType: "PROGRAM",
    },
    {
      abs: resolveProjectZonePath(projectKey, "canonical", "programs", "code_units.jsonl"),
      pathHint: "canonical/programs/code_units.jsonl",
      defaultType: "PROGRAM",
    },
    {
      abs: resolveProjectZonePath(
        projectKey,
        "canonical",
        "function-modules",
        "extracts.jsonl",
      ),
      pathHint: "canonical/function-modules/extracts.jsonl",
      defaultType: "FUNCTION_MODULE",
    },
    {
      abs: resolveProjectZonePath(projectKey, "canonical", "classes", "code_units.jsonl"),
      pathHint: "canonical/classes/code_units.jsonl",
      defaultType: "CLASS",
    },
  ];

  for (const corp of codeCorpora) {
    if (!existsSync(corp.abs)) continue;
    for await (const rec of streamJsonlObjectsMatching(corp.abs, needles)) {
      const objectName =
        asString(rec.object_name) ||
        asString(rec.program) ||
        asString(rec.function_module) ||
        asString(rec.class_name);
      const unitName =
        asString(rec.unit_name) ||
        asString(rec.form_name) ||
        asString(rec.method_name);
      const unitType = asString(rec.unit_type);
      const blob = `${objectName} ${unitName} ${unitType} ${JSON.stringify(rec).slice(0, 4000)}`;
      const mk = matchKind(anchor, blob);
      if (!mk) continue;

      let type = corp.defaultType;
      const ut = unitType.toUpperCase();
      if (ut === "FORM" || ut.includes("FORM")) type = "FORM_ROUTINE";
      else if (ut === "INCLUDE") type = "INCLUDE";
      else if (ut === "METHOD") type = "METHOD";
      else if (ut === "FUNCTION" || corp.defaultType === "FUNCTION_MODULE")
        type = "FUNCTION_MODULE";

      const id = unitName ? `${objectName}.${unitName}` : objectName;
      addEntity({
        type,
        id,
        name: unitName || objectName,
        source_path: corp.pathHint,
        match: mk,
        attributes: {
          object_name: objectName,
          unit_type: unitType,
          unit_name: unitName,
        },
      });
      code_occurrences.push({
        object_type: asString(rec.object_type) || type,
        object_name: objectName,
        unit_type: unitType || undefined,
        unit_name: unitName || undefined,
        source_path: corp.pathHint,
        tables_read: Array.isArray(rec.tables_read)
          ? (rec.tables_read as string[]).slice(0, 40)
          : undefined,
        tables_written: Array.isArray(rec.tables_written)
          ? (rec.tables_written as string[]).slice(0, 40)
          : undefined,
        call_function: Array.isArray(rec.call_function)
          ? (rec.call_function as string[]).slice(0, 40)
          : undefined,
        call_method: Array.isArray(rec.call_method)
          ? (rec.call_method as string[]).slice(0, 40)
          : undefined,
        perform: Array.isArray(rec.perform)
          ? (rec.perform as string[]).slice(0, 40)
          : undefined,
        match: mk,
      });
    }
  }

  // Program source objects
  const srcObj = resolveProjectZonePath(
    projectKey,
    "canonical",
    "programs",
    "source_objects.jsonl",
  );
  if (existsSync(srcObj)) {
    const pathHint = "canonical/programs/source_objects.jsonl";
    for await (const rec of streamJsonlObjectsMatching(srcObj, needles)) {
      const name = asString(rec.object_name);
      const mk = matchKind(anchor, `${name} ${asString(rec.description)}`);
      if (!mk) continue;
      addEntity({
        type: "PROGRAM",
        id: name,
        name,
        source_path: pathHint,
        match: mk,
        attributes: { description: asString(rec.description) },
      });
    }
  }

  // Relation corpora
  const relCorpora: Array<{ abs: string; pathHint: string }> = [
    {
      abs: resolveProjectZonePath(projectKey, "canonical", "programs", "relations.jsonl"),
      pathHint: "canonical/programs/relations.jsonl",
    },
    {
      abs: resolveProjectZonePath(
        projectKey,
        "canonical",
        "function-modules",
        "relations.jsonl",
      ),
      pathHint: "canonical/function-modules/relations.jsonl",
    },
    {
      abs: resolveProjectZonePath(projectKey, "canonical", "classes", "relations.jsonl"),
      pathHint: "canonical/classes/relations.jsonl",
    },
    {
      abs: resolveProjectZonePath(
        projectKey,
        "canonical",
        "control-tables",
        "table_relations.jsonl",
      ),
      pathHint: "canonical/control-tables/table_relations.jsonl",
    },
    {
      abs: resolveProjectZonePath(
        projectKey,
        "canonical",
        "relations",
        "code_table_links.jsonl",
      ),
      pathHint: "canonical/relations/code_table_links.jsonl",
    },
  ];

  for (const corp of relCorpora) {
    if (!existsSync(corp.abs)) continue;
    for await (const rec of streamJsonlObjectsMatching(corp.abs, needles)) {
      const from =
        asString(rec.from_name) ||
        asString(rec.from_object) ||
        asString(rec.from_object_id) ||
        asString(rec.from) ||
        asString(rec.object_name);
      const to =
        asString(rec.to_name) ||
        asString(rec.to_object) ||
        asString(rec.to_object_id) ||
        asString(rec.to) ||
        asString(rec.table_name);
      const rel =
        asString(rec.relation_type) ||
        asString(rec.relation_kind) ||
        "RELATED";
      const mk = matchKind(anchor, `${from} ${to} ${rel}`);
      if (!mk) continue;
      relations.push({
        from,
        from_type: asString(rec.from_type) || asString(rec.from_object_type),
        relation: rel,
        to,
        to_type: asString(rec.to_type) || asString(rec.to_object_type),
        source_path: corp.pathHint,
        match: mk,
      });
      bump(counts_by_type, `REL:${rel}`);
      pushUniquePath(source_paths, corp.pathHint);
    }
  }

  // Control table definitions / rows (name match)
  const ctDefs = resolveProjectZonePath(
    projectKey,
    "canonical",
    "control-tables",
    "table_definitions.jsonl",
  );
  if (existsSync(ctDefs)) {
    const pathHint = "canonical/control-tables/table_definitions.jsonl";
    for await (const rec of streamJsonlObjectsMatching(ctDefs, needles)) {
      const table = asString(rec.table_name) || asString(rec.name);
      const mk = matchKind(anchor, table);
      if (!mk) continue;
      addEntity({
        type: "CONTROL_TABLE",
        id: table,
        name: table,
        source_path: pathHint,
        match: mk,
      });
    }
  }

  const ctRows = resolveProjectZonePath(
    projectKey,
    "canonical",
    "control-tables",
    "table_rows.jsonl",
  );
  if (existsSync(ctRows)) {
    const pathHint = "canonical/control-tables/table_rows.jsonl";
    let n = 0;
    for await (const rec of streamJsonlObjectsMatching(ctRows, needles)) {
      if (n++ > 5_000) break;
      const table = asString(rec.table_name);
      const pk = asString(rec.primary_key) || asString(rec.row_key);
      const blob = `${table} ${pk} ${JSON.stringify(rec.values ?? rec.fields ?? {}).slice(0, 1500)}`;
      const mk = matchKind(anchor, blob);
      if (!mk) continue;
      addEntity({
        type: "CONTROL_TABLE_ROW",
        id: `${table}|${pk}`,
        name: `${table}|${pk}`,
        source_path: pathHint,
        match: mk,
        attributes: { table_name: table },
      });
    }
  }

  // Master-data field definitions
  const mdRoot = resolveProjectZonePath(projectKey, "canonical", "master-data");
  if (existsSync(mdRoot)) {
    for (const domain of ["materials", "customers", "vendors"] as const) {
      const domainDir = path.join(mdRoot, domain);
      if (!existsSync(domainDir) || !statSync(domainDir).isDirectory()) continue;
      for (const table of readdirSync(domainDir)) {
        const structurePath = path.join(domainDir, table, "structure.jsonl");
        if (!existsSync(structurePath)) continue;
        const pathHint = `canonical/master-data/${domain}/${table}/structure.jsonl`;
        for await (const rec of streamJsonlObjectsMatching(structurePath, needles)) {
          const field = asString(rec.field_name);
          const tableName = asString(rec.table_name) || table;
          const mk = matchKind(anchor, `${tableName} ${field} ${asString(rec.description)}`);
          if (!mk) continue;
          addEntity({
            type: "MASTER_DATA_FIELD",
            id: `${tableName}.${field}`,
            name: `${tableName}-${field}`,
            source_path: pathHint,
            match: mk,
          });
        }
      }
    }
  }

  // Class analyses (optional)
  const analyses = resolveProjectZonePath(
    projectKey,
    "analyses",
    "classes",
    "unit_analyses.jsonl",
  );
  if (existsSync(analyses)) {
    const pathHint = "analyses/classes/unit_analyses.jsonl";
    for await (const rec of streamJsonlObjectsMatching(analyses, needles)) {
      const className = asString(rec.class_name);
      const methodName = asString(rec.method_name);
      const mk = matchKind(
        anchor,
        `${className} ${methodName} ${asString(rec.search_text)} ${asString(rec.technical_summary)}`,
      );
      if (!mk) continue;
      addEntity({
        type: "METHOD",
        id: `${className}.${methodName}`,
        name: `${className}.${methodName}`,
        source_path: pathHint,
        match: mk,
        attributes: { class_name: className, method_name: methodName },
      });
    }
  }

  // Critical set (generic for technical symbols):
  // - all matching config identity objects
  // - top-level code objects whose *object name* contains the anchor (not every FORM inside)
  const critical_entity_ids: string[] = [];
  for (const e of entities) {
    const isConfig =
      e.type === "OUTPUT_TYPE" ||
      e.type === "OUTPUT_TYPE_TEXT" ||
      e.type === "OUTPUT_PROCESSING" ||
      e.type === "MESSAGE_TYPE" ||
      e.type === "IDOC_TYPE" ||
      e.type === "IDOC_EXTENSION" ||
      e.type === "PARTNER_PROFILE" ||
      e.type === "PROCESS_CODE" ||
      e.type === "PORT";
    if (isConfig) {
      critical_entity_ids.push(`${e.type}:${e.id}`);
      continue;
    }
    const objectName = String(
      e.attributes?.object_name ?? e.name ?? e.id,
    ).toUpperCase();
    const idU = e.id.toUpperCase();
    // Prefer whole-object rows (program/FM/method name contains anchor)
    const nameHasAnchor =
      objectName === anchor ||
      objectName.includes(`_${anchor}`) ||
      objectName.includes(`${anchor}_`) ||
      objectName.endsWith(anchor) ||
      objectName.startsWith(anchor);
    if (
      nameHasAnchor &&
      (e.type === "PROGRAM" ||
        e.type === "FUNCTION_MODULE" ||
        e.type === "CLASS")
    ) {
      const bare = String(e.attributes?.object_name ?? e.name);
      critical_entity_ids.push(`${e.type}:${bare}`);
    }
    if (e.type === "METHOD") {
      const methodName = String(
        e.attributes?.method_name ?? e.attributes?.unit_name ?? e.name,
      ).toUpperCase();
      if (methodName.includes(anchor)) {
        critical_entity_ids.push(`${e.type}:${e.id}`);
      }
    }
    // Processing routine linked via object id containing anchor + FORM
    if (
      e.type === "FORM_ROUTINE" &&
      nameHasAnchor &&
      idU.includes(anchor)
    ) {
      // skip nested forms unless form name itself contains anchor
      const unit = String(e.attributes?.unit_name ?? e.name).toUpperCase();
      if (unit.includes(anchor)) {
        critical_entity_ids.push(`${e.type}:${e.id}`);
      }
    }
  }

  // Critical relations: only edges whose endpoints intersect critical entities / anchor
  const criticalNameSet = new Set(
    critical_entity_ids.map((c) => c.split(":").slice(1).join(":").toUpperCase()),
  );
  criticalNameSet.add(anchor);
  const critical_relation_keys: string[] = [];
  for (const r of relations) {
    const fromU = r.from.toUpperCase();
    const toU = r.to.toUpperCase();
    const fromHit = [...criticalNameSet].some(
      (n) => fromU === n || fromU.includes(n) || n.includes(fromU),
    );
    const toHit = [...criticalNameSet].some(
      (n) => toU === n || toU.includes(n) || n.includes(toU),
    );
    // Prefer config→program / program→routine / direct calls of symbol-named FMs
    const relU = r.relation.toUpperCase();
    const important =
      relU.includes("OUTPUT") ||
      relU.includes("PROGRAM") ||
      relU.includes("ROUTINE") ||
      relU.includes("CALLS_FUNCTION") ||
      relU.includes("TECHNICAL_OBJECT");
    if (fromHit && toHit && important) {
      critical_relation_keys.push(`${r.from}|${r.relation}|${r.to}`);
    }
  }

  return {
    anchor,
    project_key: projectKey,
    generated_at: new Date().toISOString(),
    entities,
    relations,
    code_occurrences,
    configuration_chains,
    partner_assignments,
    customer_links,
    source_paths,
    counts_by_type,
    critical_entity_ids: [...new Set(critical_entity_ids)],
    critical_relation_keys: [...new Set(critical_relation_keys)].slice(0, 500),
  };
}
