/**
 * Roll method/unit hits up to parent entities; classify PRIMARY/SUPPORTING/UNCLEAR.
 * No hardcoded class names — signals from names, methods, distances, analyses.
 */
import type {
  EntityListCardItem,
  EntityListContextNode,
  EntityListRawHit,
  EntityListRole,
  EntityListTopic,
  RequestedEntityType,
} from "./types";

export function parseSourceKey(source_key: string): {
  object_type: string;
  object_name: string;
  unit_type: string;
  unit_name: string;
} {
  const parts = source_key.split("|").map((p) => p.trim());
  // D01|CLASS|ZCL_X|METHOD|Y
  const typeIdx = parts.findIndex((p) =>
    /^(CLASS|PROGRAM|FUNCTION_MODULE|FUGR|TABLE|INTERFACE)$/i.test(p),
  );
  if (typeIdx >= 0 && parts[typeIdx + 1]) {
    const object_type = parts[typeIdx]!.toUpperCase();
    const object_name = parts[typeIdx + 1]!;
    const unitTypeIdx = parts.findIndex(
      (p, i) =>
        i > typeIdx &&
        /^(METHOD|FORM|FUNCTION|PROGRAM|INCLUDE)$/i.test(p),
    );
    return {
      object_type,
      object_name,
      unit_type:
        unitTypeIdx >= 0 ? parts[unitTypeIdx]!.toUpperCase() : "UNIT",
      unit_name:
        unitTypeIdx >= 0 && parts[unitTypeIdx + 1]
          ? parts[unitTypeIdx + 1]!
          : object_name,
    };
  }
  return {
    object_type: "UNKNOWN",
    object_name: parts[2] ?? source_key,
    unit_type: "UNIT",
    unit_name: parts[parts.length - 1] ?? "",
  };
}

function topicNameTokens(topic: EntityListTopic): string[] {
  switch (topic) {
    case "EDI_MAPPING":
      return ["EDI", "EDIFACT", "EDIMAP", "IDOC", "MAP"];
    case "MAPPING":
      return ["MAP", "MAPPING", "MAPPER"];
    case "EDI":
      return ["EDI", "EDIFACT", "IDOC"];
    case "IDOC":
      return ["IDOC", "EDI"];
    default:
      return [];
  }
}

function topicMethodTokens(topic: EntityListTopic): string[] {
  switch (topic) {
    case "EDI_MAPPING":
    case "MAPPING":
      return ["MAPPING", "PRE_MAPPING", "POST_MAPPING", "MAP_"];
    case "EDI":
    case "IDOC":
      return ["EDI", "IDOC", "EDIFACT"];
    default:
      return [];
  }
}

function shortMethodName(unit: string): string {
  // ZIF_EDIFACT_PORT~MAPPING → MAPPING
  const tilde = unit.lastIndexOf("~");
  if (tilde >= 0 && tilde < unit.length - 1) return unit.slice(tilde + 1);
  return unit;
}

export function methodMatchesTopic(
  unit_name: string,
  topic: EntityListTopic,
  object_name?: string,
): boolean {
  const u = unit_name.toUpperCase();
  const short = shortMethodName(u);

  if (topic === "EDI_MAPPING" || topic === "MAPPING") {
    if (
      short === "MAPPING" ||
      short === "PRE_MAPPING" ||
      short === "POST_MAPPING"
    ) {
      return true;
    }
    if (short.includes("STYLEMAPPING") || short.includes("STYLE_MAP")) {
      return false;
    }
    // MAPPING_* / *_MAPPING helpers (not bare MAP_*)
    if (
      short.startsWith("MAPPING_") ||
      short.endsWith("_MAPPING") ||
      short.includes("_MAPPING_")
    ) {
      return true;
    }
    // MAP_* only when parent object already looks EDI/mapping-related
    if (/^MAP_/.test(short) && object_name) {
      return nameMatchesTopic(object_name, topic).strong;
    }
    return false;
  }

  for (const t of topicMethodTokens(topic)) {
    if (t.endsWith("_")) {
      if (short.startsWith(t) || u.includes(t)) return true;
    } else if (
      short === t ||
      short.endsWith(`_${t}`) ||
      short.startsWith(`${t}_`)
    ) {
      return true;
    } else if (short.includes(t) && t.length >= 6) {
      if (short === t || short.endsWith(t) || short.startsWith(t)) return true;
    }
  }
  return false;
}

export function nameMatchesTopic(
  object_name: string,
  topic: EntityListTopic,
): { strong: boolean; weak: boolean } {
  const n = object_name.toUpperCase();

  // STYLEMAPPING / Excel style — not EDI mapping
  if (/STYLE\s*MAP|STYLEMAP/i.test(n)) {
    return { strong: false, weak: true };
  }

  if (topic === "EDI_MAPPING") {
    // Strong: explicit EDI+MAP compound (EDIMAP*) or both facets in the name
    if (/EDIMAP|EDIMAPPER/.test(n)) return { strong: true, weak: false };
    const hasEdi = /EDI|EDIFACT|IDOC/.test(n);
    const hasMap = /MAP/.test(n); // "EDIFACT" does not contain "MAP"
    if (hasEdi && hasMap) return { strong: true, weak: false };
    if (hasEdi || hasMap) return { strong: false, weak: true };
    return { strong: false, weak: false };
  }

  const tokens = topicNameTokens(topic);
  let strong = false;
  let weak = false;
  for (const t of tokens) {
    if (n.includes(t)) {
      if (t.length >= 4) strong = true;
      else weak = true;
    }
  }
  return { strong, weak };
}

function mapObjectType(t: string): RequestedEntityType | "OTHER" {
  const u = t.toUpperCase();
  if (u === "CLASS" || u === "INTERFACE") return "CLASS";
  if (u === "PROGRAM") return "PROGRAM";
  if (u === "TABLE") return "TABLE";
  if (u === "FUNCTION_MODULE" || u === "FUGR") return "FUNCTION_MODULE";
  if (u === "METHOD") return "METHOD";
  return "OTHER";
}

function roleLabel(role: EntityListRole, entityType: RequestedEntityType): string {
  if (entityType === "CLASS") {
    if (role === "PRIMARY") return "Primäre Mapping-Klasse";
    if (role === "SUPPORTING") return "Unterstützende Klasse";
    return "Unklarer Treffer";
  }
  if (role === "PRIMARY") return "Primärer Treffer";
  if (role === "SUPPORTING") return "Unterstützender Treffer";
  return "Unklarer Treffer";
}

function classifyRole(params: {
  entity_name: string;
  entity_type: RequestedEntityType;
  topic: EntityListTopic;
  matched_methods: string[];
  topic_methods: string[];
  direct_hits: number;
  graph_distance: number | null;
  summaries: string[];
}): { role: EntityListRole; rationale: string } {
  const nameHit = nameMatchesTopic(params.entity_name, params.topic);
  const topicMethodCount = params.topic_methods.length;
  const hasDirect = params.direct_hits > 0;
  const dist = params.graph_distance;
  const analysisHit = params.summaries.some((s) => {
    const u = s.toUpperCase();
    return topicNameTokens(params.topic).some((t) => u.includes(t));
  });

  // Weak name-only (e.g. STYLEMAPPING, program containing KLASSE) without topic methods
  if (
    !nameHit.strong &&
    topicMethodCount === 0 &&
    !analysisHit &&
    (nameHit.weak || !hasDirect || (dist !== null && dist >= 2))
  ) {
    return {
      role: "UNCLEAR",
      rationale:
        "Nur Symbolähnlichkeit oder schwache Graphbeziehung — kein ausreichender fachlicher Beleg.",
    };
  }

  // Primary: strong name OR multiple topic methods + direct hits
  if (
    (nameHit.strong && topicMethodCount >= 1 && hasDirect) ||
    (topicMethodCount >= 2 && hasDirect) ||
    (nameHit.strong && hasDirect && topicMethodCount >= 1)
  ) {
    const methodPart =
      topicMethodCount > 0
        ? `Direkte Treffer auf ${params.topic_methods.slice(0, 6).join(", ")}.`
        : "Direkte Treffer mit themenbezogenem Klassennamen.";
    return {
      role: "PRIMARY",
      rationale: methodPart,
    };
  }

  if (
    nameHit.strong &&
    hasDirect &&
    (topicMethodCount >= 1 || analysisHit)
  ) {
    return {
      role: "PRIMARY",
      rationale: `Klassenname und Direkttreffer belegen Themenbezug${
        topicMethodCount
          ? ` (${params.topic_methods.slice(0, 4).join(", ")})`
          : ""
      }.`,
    };
  }

  // Supporting: single helper method, indirect, tools
  if (
    topicMethodCount === 1 ||
    (nameHit.weak && topicMethodCount >= 1) ||
    (hasDirect && topicMethodCount >= 1 && !nameHit.strong) ||
    (dist !== null && dist >= 1 && (nameHit.strong || topicMethodCount >= 1))
  ) {
    return {
      role: "SUPPORTING",
      rationale:
        topicMethodCount === 1
          ? `Einzelne themenbezogene Methode (${params.topic_methods[0]})${
              /TOOL/i.test(params.entity_name) ? " in allgemeiner Tool-Klasse" : ""
            }.`
          : dist !== null && dist >= 1
            ? `Indirekte Graphbeziehung (Distanz ${dist}).`
            : "Teilweiser Themenbezug ohne starke Primärsignale.",
    };
  }

  if (nameHit.strong && !hasDirect) {
    return {
      role: "SUPPORTING",
      rationale: "Themenbezogener Name, aber kein Direkttreffer auf Mapping-Methoden.",
    };
  }

  return {
    role: "UNCLEAR",
    rationale:
      "Treffer ohne ausreichenden fachlichen Beleg für die geforderte Rolle.",
  };
}

export function hitsFromGraph(params: {
  graph_paths: Array<{
    source_key: string;
    object_name: string;
    unit_name: string;
    distance: number;
    path_relations: string[];
  }>;
  cached_analyses: Array<{
    source_key: string;
    object_name: string;
    unit_name: string;
    summary: string | null;
    cache_hit: boolean;
  }>;
}): EntityListRawHit[] {
  const summaryByKey = new Map(
    params.cached_analyses.map((a) => [a.source_key, a]),
  );
  const out: EntityListRawHit[] = [];
  const seen = new Set<string>();
  for (const p of params.graph_paths) {
    if (seen.has(p.source_key)) continue;
    seen.add(p.source_key);
    const parsed = parseSourceKey(p.source_key);
    const cache = summaryByKey.get(p.source_key);
    out.push({
      source_key: p.source_key,
      object_type: parsed.object_type,
      object_name: p.object_name || parsed.object_name,
      unit_type: parsed.unit_type,
      unit_name: p.unit_name || parsed.unit_name,
      distance: p.distance,
      path_relations: p.path_relations,
      summary: cache?.summary ?? null,
      cache_hit: cache?.cache_hit ?? false,
    });
  }
  return out;
}

export function aggregateEntityList(params: {
  hits: EntityListRawHit[];
  requested_entity_type: RequestedEntityType;
  topic: EntityListTopic;
  authoritative_nodes?: string[];
}): {
  items: EntityListCardItem[];
  filtered_out: Array<{ kind: string; name: string; note: string }>;
  raw_hit_count: number;
} {
  const filtered_out: Array<{ kind: string; name: string; note: string }> = [];
  const byEntity = new Map<
    string,
    {
      entity_name: string;
      entity_type: RequestedEntityType;
      methods: Set<string>;
      topic_methods: Set<string>;
      source_keys: string[];
      distances: number[];
      summaries: string[];
      relations: string[];
      context: EntityListContextNode[];
    }
  >();

  const want = params.requested_entity_type;

  for (const hit of params.hits) {
    const mapped = mapObjectType(hit.object_type);
    // METHOD requests: keep method-level; otherwise roll up to parent object
    if (want === "METHOD") {
      // treat each method as entity
      const key = `${hit.object_name}|${hit.unit_name}`;
      let bucket = byEntity.get(key);
      if (!bucket) {
        bucket = {
          entity_name: `${hit.object_name}.${hit.unit_name}`,
          entity_type: "METHOD",
          methods: new Set(),
          topic_methods: new Set(),
          source_keys: [],
          distances: [],
          summaries: [],
          relations: [],
          context: [],
        };
        byEntity.set(key, bucket);
      }
      bucket.methods.add(hit.unit_name);
      if (methodMatchesTopic(hit.unit_name, params.topic, hit.object_name)) {
        bucket.topic_methods.add(shortMethodName(hit.unit_name));
      }
      bucket.source_keys.push(hit.source_key);
      bucket.distances.push(hit.distance);
      if (hit.summary) bucket.summaries.push(hit.summary);
      bucket.relations.push(...hit.path_relations);
      continue;
    }

    if (mapped === "OTHER" || (want !== "UNKNOWN" && mapped !== want)) {
      filtered_out.push({
        kind: hit.object_type || mapped,
        name: hit.object_name,
        note: `${hit.unit_type}|${hit.unit_name} (nicht ${want})`,
      });
      continue;
    }

    const key = hit.object_name.toUpperCase();
    let bucket = byEntity.get(key);
    if (!bucket) {
      bucket = {
        entity_name: hit.object_name,
        entity_type: mapped === "OTHER" ? "UNKNOWN" : mapped,
        methods: new Set(),
        topic_methods: new Set(),
        source_keys: [],
        distances: [],
        summaries: [],
        relations: [],
        context: [],
      };
      byEntity.set(key, bucket);
    }
    if (hit.unit_name && hit.unit_name !== hit.object_name) {
      bucket.methods.add(hit.unit_name);
      if (methodMatchesTopic(hit.unit_name, params.topic, hit.object_name)) {
        bucket.topic_methods.add(shortMethodName(hit.unit_name));
      }
    }
    bucket.source_keys.push(hit.source_key);
    bucket.distances.push(hit.distance);
    if (hit.summary) bucket.summaries.push(hit.summary);
    bucket.relations.push(...hit.path_relations);
  }

  // Attach filtered nodes as context when they share topic tokens with an entity
  for (const fo of filtered_out) {
    for (const [, bucket] of byEntity) {
      const hay = bucket.entity_name.toUpperCase();
      const other = fo.name.toUpperCase();
      if (
        (hay.includes("EDI") && other.includes("EDI")) ||
        bucket.relations.some((r) => r.toUpperCase().includes(other.slice(0, 8)))
      ) {
        if (bucket.context.length < 4) {
          bucket.context.push({
            kind: fo.kind,
            name: fo.name,
            note: fo.note,
          });
        }
      }
    }
  }

  // Authoritative non-class nodes → filtered evidence only
  for (const n of params.authoritative_nodes ?? []) {
    const [kind, name] = n.includes(":")
      ? (n.split(":") as [string, string])
      : ["NODE", n];
    const mapped = mapObjectType(kind);
    if (want !== "UNKNOWN" && mapped !== want && mapped !== "OTHER") {
      filtered_out.push({
        kind,
        name: name ?? n,
        note: "autoritativer Graphknoten (nicht Hauptergebnis)",
      });
    } else if (mapped === "OTHER" || kind === "LOGICAL_SYSTEM" || kind === "PARTNER_PROFILE") {
      filtered_out.push({
        kind,
        name: name ?? n,
        note: "autoritativer Graphknoten (nicht Hauptergebnis)",
      });
    }
  }

  const items: EntityListCardItem[] = [];
  for (const bucket of byEntity.values()) {
    const matched_methods = [...bucket.methods].sort((a, b) =>
      a.localeCompare(b),
    );
    const topic_methods = [...bucket.topic_methods].sort((a, b) =>
      a.localeCompare(b),
    );
    // Prefer topic methods for display; fall back to all matched units
    const display_methods = (
      topic_methods.length > 0
        ? topic_methods
        : matched_methods.map(shortMethodName)
    ).sort((a, b) => {
      const rank = (m: string) => {
        const s = m.toUpperCase();
        if (s === "MAPPING" || s.endsWith("~MAPPING")) return 0;
        if (s === "PRE_MAPPING" || s.endsWith("~PRE_MAPPING")) return 1;
        if (s === "POST_MAPPING" || s.endsWith("~POST_MAPPING")) return 2;
        return 3;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });

    const direct_hits = bucket.distances.filter((d) => d === 0).length;
    const graph_distance =
      bucket.distances.length > 0
        ? Math.min(...bucket.distances)
        : null;

    const { role, rationale: baseRationale } = classifyRole({
      entity_name: bucket.entity_name,
      entity_type: bucket.entity_type,
      topic: params.topic,
      matched_methods,
      topic_methods, // only real topic methods — never all units
      direct_hits,
      graph_distance,
      summaries: bucket.summaries,
    });
    const rationale =
      topic_methods.length > 0 && baseRationale.startsWith("Direkte Treffer")
        ? `Direkte Treffer auf ${[
            ...topic_methods.filter((m) =>
              /^(PRE_|POST_)?MAPPING$/i.test(shortMethodName(m)),
            ),
            ...topic_methods.filter(
              (m) => !/^(PRE_|POST_)?MAPPING$/i.test(shortMethodName(m)),
            ),
          ]
            .slice(0, 6)
            .join(", ")}.`
        : baseRationale;

    const evidence_status =
      role === "PRIMARY"
        ? "Themenbezug durch Direkttreffer belegt"
        : role === "SUPPORTING"
          ? "Teilweiser Themenbezug belegt"
          : "Themenbezug unklar";

    items.push({
      entity_name: bucket.entity_name,
      entity_type: bucket.entity_type,
      role,
      role_label: roleLabel(role, bucket.entity_type),
      rationale,
      matched_methods: display_methods,
      occurrence_count: bucket.source_keys.length,
      direct_hits,
      graph_distance,
      evidence_sources: [...new Set(bucket.source_keys)].slice(0, 12),
      evidence_status,
      context_nodes: bucket.context.slice(0, 4),
      hit_kind: direct_hits > 0 ? "direct" : "graph",
    });
  }

  // Sort: PRIMARY first, then SUPPORTING, then UNCLEAR; within by methods/direct hits
  const roleOrder: Record<EntityListRole, number> = {
    PRIMARY: 0,
    SUPPORTING: 1,
    UNCLEAR: 2,
  };
  items.sort(
    (a, b) =>
      roleOrder[a.role] - roleOrder[b.role] ||
      b.matched_methods.length - a.matched_methods.length ||
      b.direct_hits - a.direct_hits ||
      a.entity_name.localeCompare(b.entity_name),
  );

  // Deduplicate filtered_out
  const foSeen = new Set<string>();
  const filtered_dedup = filtered_out.filter((f) => {
    const k = `${f.kind}|${f.name}`;
    if (foSeen.has(k)) return false;
    foSeen.add(k);
    return true;
  });

  return {
    items,
    filtered_out: filtered_dedup.slice(0, 40),
    raw_hit_count: params.hits.length,
  };
}
