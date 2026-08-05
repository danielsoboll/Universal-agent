/**
 * Lightweight question-intent classifier for synthesis weighting.
 * Deterministic heuristics only — does not alter Direct RAG retrieval ranking.
 * No customer-specific entity fixtures.
 */

export type QuestionIntent =
  | "business_process"
  | "technical_implementation"
  | "comparison"
  | "entity_specific"
  | "data_lookup"
  | "architecture"
  | "unknown";

export type QuestionIntentResult = {
  intent: QuestionIntent;
  confidence: number;
  signals: string[];
  /** Soft preferences for evidence assembly / prompt weighting. */
  preferences: {
    prefer_code: boolean;
    prefer_tables: boolean;
    prefer_relations: boolean;
    prefer_process_weight: boolean;
    prefer_tech_weight: boolean;
    require_both_comparison_sides: boolean;
  };
};

const COMPARISON_RE =
  /\b(unterschied|vergleich|gegenüber|gegenueber|vs\.?|versus|alt\s*(und|\/|,)\s*neu|neu\s*(und|\/|,)\s*alt|beide|gegenüberstellung)\b/i;
const TECH_RE =
  /\b(methode|funktion|klasse|programm|include|form|routine|implementier|technisch|aufruf|call|sy-subrc|hardcod|abap|source)\b/i;
const PROCESS_RE =
  /\b(prozess|ablauf|fachlich|geschäftlich|geschaeftlich|warum|wozu|bedeutung|wirkung|besonderheit|kunde|kunden)\b/i;
const DATA_RE =
  /\b(tabelle|feld|spalte|zeile|wert|inhalt|customizing|steuertabelle|eintrag)\b/i;
const ARCH_RE =
  /\b(architektur|schnittstelle|integration|landschaft|modul|schicht|komponente)\b/i;
/** Named entities / technical ids — generic patterns only. */
const ENTITY_RE =
  /\b([A-Z][A-Z0-9_]{3,}|[A-ZÄÖÜ][a-zäöüß]{3,}(?:\s+[A-ZÄÖÜ][a-zäöüß]{2,})?)\b/;

export function classifyQuestionIntent(question: string): QuestionIntentResult {
  const q = question.trim();
  const signals: string[] = [];
  let intent: QuestionIntent = "unknown";
  let confidence = 0.35;

  const isComparison = COMPARISON_RE.test(q);
  const isTech = TECH_RE.test(q);
  const isProcess = PROCESS_RE.test(q);
  const isData = DATA_RE.test(q);
  const isArch = ARCH_RE.test(q);
  const hasEntity = ENTITY_RE.test(q);

  if (isComparison) {
    intent = "comparison";
    confidence = 0.85;
    signals.push("comparison_keywords");
  } else if (isArch && !isProcess) {
    intent = "architecture";
    confidence = 0.7;
    signals.push("architecture_keywords");
  } else if (isTech && !isProcess) {
    intent = "technical_implementation";
    confidence = 0.75;
    signals.push("technical_keywords");
  } else if (isData && !isProcess) {
    intent = "data_lookup";
    confidence = 0.7;
    signals.push("data_keywords");
  } else if (isProcess) {
    intent = "business_process";
    confidence = 0.7;
    signals.push("process_keywords");
  } else if (hasEntity) {
    intent = "entity_specific";
    confidence = 0.6;
    signals.push("named_entity");
  }

  if (hasEntity && intent !== "entity_specific" && intent !== "comparison") {
    signals.push("named_entity_secondary");
  }

  const prefer_tech_weight =
    intent === "technical_implementation" ||
    intent === "architecture" ||
    intent === "data_lookup";
  const prefer_process_weight =
    intent === "business_process" || intent === "entity_specific";

  return {
    intent,
    confidence,
    signals,
    preferences: {
      prefer_code:
        prefer_tech_weight ||
        intent === "comparison" ||
        intent === "entity_specific",
      prefer_tables:
        intent === "data_lookup" ||
        intent === "business_process" ||
        intent === "comparison",
      prefer_relations:
        intent === "architecture" ||
        intent === "comparison" ||
        prefer_tech_weight,
      prefer_process_weight,
      prefer_tech_weight,
      require_both_comparison_sides: intent === "comparison",
    },
  };
}

/** Detect alt/neu side labels in text for comparison honesty checks (generic). */
export function detectComparisonSides(texts: string[]): {
  has_alt: boolean;
  has_neu: boolean;
} {
  const blob = texts.join("\n");
  return {
    has_alt: /\b(alt|old|_alt\b|vorher|bisher)\b/i.test(blob),
    has_neu: /\b(neu|new|_neu\b|nachher|aktuell)\b/i.test(blob),
  };
}

/**
 * Topic anchors from the question for evidence diversification (synthesis only).
 * Generic: content words + technical tokens from the question — no customer fixtures.
 */
export function questionTopicAnchors(question: string): string[] {
  const q = question.toLowerCase();
  const stop = new Set([
    "wie",
    "was",
    "welche",
    "welcher",
    "welches",
    "genau",
    "funktioniert",
    "wissen",
    "über",
    "bei",
    "vom",
    "von",
    "der",
    "die",
    "das",
    "und",
    "oder",
    "mit",
    "ohne",
    "eine",
    "einen",
    "einem",
  ]);
  const anchors = new Set<string>();
  for (const part of q.split(/[^a-zäöüß0-9_]+/i)) {
    if (part.length >= 4 && !stop.has(part)) anchors.add(part);
  }
  for (const m of question.matchAll(
    /\b([ZzYy][A-Za-z0-9_]{2,}|[A-Z][A-Z0-9_]{3,})\b/g,
  )) {
    anchors.add(m[1]!.toLowerCase());
  }
  return [...anchors].slice(0, 24);
}
