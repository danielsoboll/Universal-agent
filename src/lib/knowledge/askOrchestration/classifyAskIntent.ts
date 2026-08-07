/**
 * Deterministic ask intent router — no OpenAI, no question hardcoding.
 */
import { classifyInventoryIntent } from "@/lib/knowledge/inventoryAggregation/classifyInventoryIntent";
import { classifyEntityListIntent } from "@/lib/knowledge/entityListAggregation/classifyEntityListIntent";
import { classifyHardcodedValueIntent } from "@/lib/knowledge/hardcodedValueInventory/classifyHardcodedValueIntent";
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";

export type AskOrchestrationIntent =
  | "OBJECT_LOOKUP"
  | "PROCESS_EXPLANATION"
  | "INVENTORY_AND_AGGREGATION"
  | "ENTITY_LIST"
  | "HARDCODED_VALUE_INVENTORY"
  | "TECHNICAL_TRACE"
  | "COMPARISON"
  | "UNKNOWN";

export type AskIntentClassification = {
  intent: AskOrchestrationIntent;
  confidence: number;
  signals: string[];
  technical_symbols: string[];
  /** Soft lexical seeds (no stopwords) for graph/hybrid when symbols are sparse. */
  lexical_seeds: string[];
  /** Present when intent is ENTITY_LIST. */
  entity_list?: import("@/lib/knowledge/entityListAggregation").EntityListQueryClassification;
  /** Present when intent is HARDCODED_VALUE_INVENTORY. */
  hardcoded_value?: import("@/lib/knowledge/hardcodedValueInventory").HardcodedValueQueryClassification;
};

const COMPARISON_RE =
  /\b(unterschied|vergleich|gegenüber|gegenueber|vs\.?|versus|beide|gegenüberstellung)\b/i;
const PROCESS_RE =
  /\b(wie\s+funktioniert|wie\s+läuft|ablauf|prozess|was\s+passiert|wie\s+wird|funktioniert)\b/i;
const TRACE_RE =
  /\b(technisch|trace|aufrufkette|call\s*stack|was\s+passiert\s+technisch|verarbeitungsschritt|implementier)\b/i;
const LOOKUP_RE =
  /\b(was\s+ist|was\s+wissen\s+wir|erkläre|erklare|definiere|bedeutet|über\s+|ueber\s+)\b/i;
const INVENTORY_DOMAIN_RE =
  /\b(nachrichten|outputarten|ausgabearten|tabellen|programme|schnittstellen|liefemachrichten|liefernachrichten)\b/i;

const LEXICAL_STOP = new Set(
  [
    "wie",
    "was",
    "welche",
    "welcher",
    "welches",
    "welchen",
    "der",
    "die",
    "das",
    "den",
    "dem",
    "ein",
    "eine",
    "einer",
    "eines",
    "und",
    "oder",
    "mit",
    "bei",
    "von",
    "vom",
    "zum",
    "zur",
    "für",
    "fuer",
    "über",
    "ueber",
    "unter",
    "auf",
    "aus",
    "ist",
    "sind",
    "wird",
    "werden",
    "wurde",
    "haben",
    "hat",
    "kann",
    "können",
    "wir",
    "wissen",
    "bitte",
    "noch",
    "auch",
    "nur",
    "alle",
    "alles",
    "dazu",
    "davon",
    "sich",
    "nicht",
    "kein",
    "keine",
    "funktionieren",
    "funktioniert",
    "passiert",
    "technisch",
    "ablauf",
    "prozess",
  ].map((s) => s.toLowerCase()),
);

export function extractLexicalSeeds(question: string): string[] {
  const tokens = question
    .split(/[^A-Za-zÄÖÜäöüß0-9_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const key = t.toUpperCase();
    if (seen.has(key) || key.length < 4) return;
    seen.add(key);
    out.push(t);
  };
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (LEXICAL_STOP.has(lower)) continue;
    push(t);
    // Prefix variants help match ZCL_VIRTUELLES_LAGER from "virtuelle"
    if (t.length >= 6) push(t.slice(0, 6));
    if (t.length >= 8) push(t.slice(0, 8));
  }
  return out.slice(0, 16);
}

/**
 * Classify ask intent for orchestration routing.
 * Inventory cues win when set/list + domain; otherwise process/trace/lookup/comparison.
 */
export function classifyAskIntent(question: string): AskIntentClassification {
  const q = question.trim();
  const symbols = extractTechnicalSymbols(q).map((s) => s.norm);
  const lexical_seeds = extractLexicalSeeds(q);
  const signals: string[] = [];

  const inv = classifyInventoryIntent(q);
  if (inv.intent === "INVENTORY_AND_AGGREGATION") {
    return {
      intent: "INVENTORY_AND_AGGREGATION",
      confidence: 0.9,
      signals: ["inventory_classifier", ...inv.matched_cues],
      technical_symbols: symbols,
      lexical_seeds,
    };
  }

  const hc = classifyHardcodedValueIntent(q);
  if (hc.intent === "HARDCODED_VALUE_INVENTORY") {
    return {
      intent: "HARDCODED_VALUE_INVENTORY",
      confidence: 0.92,
      signals: ["hardcoded_value_classifier", ...hc.matched_cues],
      technical_symbols: symbols,
      lexical_seeds,
      hardcoded_value: hc,
    };
  }

  const el = classifyEntityListIntent(q);
  if (el.intent === "ENTITY_LIST") {
    return {
      intent: "ENTITY_LIST",
      confidence: 0.9,
      signals: ["entity_list_classifier", ...el.matched_cues],
      technical_symbols: symbols,
      lexical_seeds: [
        ...el.topic_seeds,
        ...lexical_seeds.filter(
          (s) =>
            !/^(diese|klasse|klassen|machen|welche|welcher|liste|sind)$/i.test(
              s,
            ),
        ),
      ].slice(0, 16),
      entity_list: el,
    };
  }

  if (COMPARISON_RE.test(q)) {
    signals.push("comparison_keywords");
    return {
      intent: "COMPARISON",
      confidence: 0.85,
      signals,
      technical_symbols: symbols,
      lexical_seeds,
    };
  }

  const isTrace = TRACE_RE.test(q);
  const isProcess = PROCESS_RE.test(q);
  const isLookup = LOOKUP_RE.test(q);

  if (isTrace && (symbols.length > 0 || isProcess)) {
    signals.push("technical_trace_keywords");
    if (symbols.length) signals.push("technical_symbol");
    return {
      intent: "TECHNICAL_TRACE",
      confidence: symbols.length ? 0.88 : 0.7,
      signals,
      technical_symbols: symbols,
      lexical_seeds,
    };
  }

  if (isProcess) {
    signals.push("process_keywords");
    return {
      intent: "PROCESS_EXPLANATION",
      confidence: 0.85,
      signals,
      technical_symbols: symbols,
      lexical_seeds,
    };
  }

  if (isLookup || (symbols.length === 1 && /\bwas\b/i.test(q))) {
    signals.push(isLookup ? "lookup_keywords" : "single_symbol_lookup");
    return {
      intent: "OBJECT_LOOKUP",
      confidence: symbols.length ? 0.85 : 0.65,
      signals,
      technical_symbols: symbols,
      lexical_seeds,
    };
  }

  if (symbols.length > 0 && INVENTORY_DOMAIN_RE.test(q) === false) {
    // Bare technical token questions default to object lookup
    if (/^(was|wer|wo|welch)/i.test(q) || symbols.length === 1) {
      signals.push("symbol_default_lookup");
      return {
        intent: "OBJECT_LOOKUP",
        confidence: 0.7,
        signals,
        technical_symbols: symbols,
        lexical_seeds,
      };
    }
    signals.push("symbol_default_trace");
    return {
      intent: "TECHNICAL_TRACE",
      confidence: 0.65,
      signals,
      technical_symbols: symbols,
      lexical_seeds,
    };
  }

  return {
    intent: "UNKNOWN",
    confidence: 0.4,
    signals: ["no_strong_cue"],
    technical_symbols: symbols,
    lexical_seeds,
  };
}
