/**
 * Classify ENTITY_LIST questions — no object-name hardcoding.
 */
import type {
  EntityListDetailDepth,
  EntityListQueryClassification,
  EntityListTopic,
  RequestedEntityType,
} from "./types";

const LIST_CUE_RE =
  /\b(welche|welcher|welches|welchen|liste|auflisten|aufzählen|aufzaehlen|nenn(?:e|en)|zeige|zeig|beteiligt(?:en|e)?|sind\s+das|gibt\s+es)\b/i;

const CLASS_RE =
  /\b(klassen?|class(?:es)?|zcl_[a-z0-9_]*|oo[\s-]?klassen?)\b/i;
const PROGRAM_RE = /\b(programme?|reports?|prog(?:ramme)?)\b/i;
const TABLE_RE = /\b(tabellen?|tables?|db[\s-]?tabellen?)\b/i;
const METHOD_RE = /\b(methoden?|methods?)\b/i;
const FM_RE =
  /\b(funktionsbausteine?|function[\s-]?modules?|fb\b)\b/i;

const EDI_RE = /\b(edi|edifact|idoc)\b/i;
const MAPPING_RE = /\b(mapping|mappen|mapper|abbildung)\b/i;
const IDOC_ONLY_RE = /\b(idoc|ido[ck]s?)\b/i;

function detectEntityType(q: string): {
  type: RequestedEntityType;
  cue: string | null;
} {
  if (CLASS_RE.test(q)) return { type: "CLASS", cue: "entity:class" };
  if (PROGRAM_RE.test(q)) return { type: "PROGRAM", cue: "entity:program" };
  if (TABLE_RE.test(q)) return { type: "TABLE", cue: "entity:table" };
  if (METHOD_RE.test(q)) return { type: "METHOD", cue: "entity:method" };
  if (FM_RE.test(q)) return { type: "FUNCTION_MODULE", cue: "entity:fm" };
  return { type: "UNKNOWN", cue: null };
}

function detectTopic(q: string): {
  topic: EntityListTopic;
  label: string;
  seeds: string[];
  cues: string[];
} {
  const hasEdi = EDI_RE.test(q);
  const hasMap = MAPPING_RE.test(q);
  const hasIdoc = IDOC_ONLY_RE.test(q);
  const cues: string[] = [];
  if (hasEdi) cues.push("topic:edi");
  if (hasMap) cues.push("topic:mapping");
  if (hasIdoc) cues.push("topic:idoc");

  if (hasEdi && hasMap) {
    return {
      topic: "EDI_MAPPING",
      label: "EDI-Mapping",
      // Prefer specific tokens — short "EDI"/"IDOC" flood the selector.
      seeds: [
        "MAPPING",
        "PRE_MAPPING",
        "POST_MAPPING",
        "EDIMAP",
        "EDIFACT",
        "EDIMAPPER",
      ],
      cues,
    };
  }
  if (hasMap) {
    return {
      topic: "MAPPING",
      label: "Mapping",
      seeds: ["MAPPING", "PRE_MAPPING", "POST_MAPPING", "MAPPER"],
      cues,
    };
  }
  if (hasEdi) {
    return {
      topic: "EDI",
      label: "EDI",
      seeds: ["EDIFACT", "EDIMAP", "EDI_"],
      cues,
    };
  }
  if (hasIdoc) {
    return {
      topic: "IDOC",
      label: "IDoc",
      seeds: ["IDOC", "EDIFACT"],
      cues,
    };
  }
  return {
    topic: "GENERIC",
    label: "gesucht",
    seeds: [],
    cues,
  };
}

function detectDetailDepth(q: string): EntityListDetailDepth {
  if (/\b(beleg|evidenz|quelle|detail|technisch)\b/i.test(q)) {
    return "WITH_EVIDENCE";
  }
  if (/\b(methoden|wie|ablauf|funktion)\b/i.test(q)) {
    return "WITH_METHODS";
  }
  // Default for list questions: show methods under each entity
  return "WITH_METHODS";
}

/**
 * ENTITY_LIST when list cue + requested entity type (Klassen/Programme/…).
 * Inventory (delivery messages) is classified separately and wins first.
 */
export function classifyEntityListIntent(
  question: string,
): EntityListQueryClassification {
  const q = question.trim();
  const matched_cues: string[] = [];
  const entity = detectEntityType(q);
  const topicInfo = detectTopic(q);
  const hasList = LIST_CUE_RE.test(q);

  if (hasList) matched_cues.push("list_cue");
  if (entity.cue) matched_cues.push(entity.cue);
  matched_cues.push(...topicInfo.cues);

  const isEntityList =
    hasList &&
    entity.type !== "UNKNOWN" &&
    // Avoid stealing pure method-name dumps without topic when too vague —
    // still allow "welche Methoden" as ENTITY_LIST.
    true;

  if (!isEntityList) {
    return {
      intent: "NOT_ENTITY_LIST",
      requested_entity_type: entity.type,
      topic: topicInfo.topic,
      topic_label: topicInfo.label,
      detail_depth: detectDetailDepth(q),
      topic_seeds: topicInfo.seeds,
      matched_cues,
    };
  }

  return {
    intent: "ENTITY_LIST",
    requested_entity_type: entity.type,
    topic: topicInfo.topic,
    topic_label: topicInfo.label,
    detail_depth: detectDetailDepth(q),
    topic_seeds: topicInfo.seeds,
    matched_cues,
  };
}

export function isEntityListQuestion(question: string): boolean {
  return classifyEntityListIntent(question).intent === "ENTITY_LIST";
}
