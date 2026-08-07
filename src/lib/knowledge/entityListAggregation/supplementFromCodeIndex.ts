/**
 * Supplement graph hits from the code-unit index using topic tokens.
 * Avoids short-seed flooding (EDI/IDOC) drowning out MAPPING methods.
 */
import { loadCodeUnitIndex } from "@/lib/knowledge/graphSelector/loadGraph";
import {
  methodMatchesTopic,
  nameMatchesTopic,
} from "./aggregateEntities";
import type {
  EntityListRawHit,
  EntityListTopic,
  RequestedEntityType,
} from "./types";

function corpusMatchesType(
  object_type: string,
  requested: RequestedEntityType,
): boolean {
  const u = object_type.toUpperCase();
  if (requested === "CLASS") return u === "CLASS" || u === "INTERFACE";
  if (requested === "PROGRAM") return u === "PROGRAM";
  if (requested === "FUNCTION_MODULE") {
    return u === "FUNCTION_MODULE" || u === "FUGR" || u === "FUNCTION";
  }
  if (requested === "METHOD") return u === "CLASS" || u === "INTERFACE";
  if (requested === "TABLE") return u === "TABLE";
  return true;
}

function topicUnitLookupKeys(topic: EntityListTopic): string[] {
  switch (topic) {
    case "EDI_MAPPING":
    case "MAPPING":
      return [
        "MAPPING",
        "PRE_MAPPING",
        "POST_MAPPING",
        "ZIF_EDIFACT_PORT~MAPPING",
        "ZIF_EDIFACT_PORT~PRE_MAPPING",
        "ZIF_EDIFACT_PORT~POST_MAPPING",
      ];
    case "EDI":
      return [];
    case "IDOC":
      return [];
    default:
      return [];
  }
}

export async function supplementHitsFromCodeIndex(params: {
  projectKey: string;
  topic: EntityListTopic;
  requested_entity_type: RequestedEntityType;
  existing: EntityListRawHit[];
  limit?: number;
}): Promise<EntityListRawHit[]> {
  if (params.topic === "GENERIC") return params.existing;

  const index = await loadCodeUnitIndex(params.projectKey, {
    includeSourceCode: false,
  });
  const seen = new Set(params.existing.map((h) => h.source_key));
  const added: EntityListRawHit[] = [];
  const limit = params.limit ?? 120;

  const pushRef = (
    ref: {
      source_key: string;
      object_type: string;
      object_name: string;
      unit_type: string;
      unit_name: string;
    },
    distance = 0,
  ) => {
    if (added.length >= limit) return;
    if (seen.has(ref.source_key)) return;
    if (!corpusMatchesType(ref.object_type, params.requested_entity_type)) {
      return;
    }
    if (!methodMatchesTopic(ref.unit_name, params.topic, ref.object_name)) {
      return;
    }
    seen.add(ref.source_key);
    added.push({
      source_key: ref.source_key,
      object_type: ref.object_type,
      object_name: ref.object_name,
      unit_type: ref.unit_type,
      unit_name: ref.unit_name,
      distance,
      path_relations: [],
      summary: null,
      cache_hit: false,
    });
  };

  // 1) Direct unit-name index lookups (fast path)
  for (const key of topicUnitLookupKeys(params.topic)) {
    const refs = index.byUnitName.get(key.toUpperCase()) ?? [];
    for (const ref of refs) pushRef(ref);
  }

  // 2) Scan unit-name keys for topic method patterns (e.g. MAPPING / PRE_MAPPING)
  for (const [unitKey, refs] of index.byUnitName) {
    if (added.length >= limit) break;
    // Unit-key scan without object context: only exact mapping method names
    if (
      !methodMatchesTopic(unitKey, params.topic) &&
      !refs.some((r) =>
        methodMatchesTopic(r.unit_name, params.topic, r.object_name),
      )
    ) {
      continue;
    }
    for (const ref of refs) pushRef(ref);
  }

  // 3) Strong name matches: EDIMAP* classes — add topic methods only
  for (const [objKey, refs] of index.byObjectName) {
    if (added.length >= limit) break;
    if (!nameMatchesTopic(objKey, params.topic).strong) continue;
    for (const ref of refs) {
      if (methodMatchesTopic(ref.unit_name, params.topic, ref.object_name)) {
        pushRef(ref);
      }
    }
  }

  // 4) Complete sibling topic methods only on classes that already have a topic method hit
  const strongClasses = new Set<string>();
  for (const h of [...params.existing, ...added]) {
    if (methodMatchesTopic(h.unit_name, params.topic, h.object_name)) {
      strongClasses.add(h.object_name.toUpperCase());
    }
  }
  for (const cls of strongClasses) {
    const refs = index.byObjectName.get(cls) ?? [];
    for (const ref of refs) {
      if (methodMatchesTopic(ref.unit_name, params.topic, ref.object_name)) {
        pushRef(ref);
      }
    }
  }

  return [...params.existing, ...added];
}
