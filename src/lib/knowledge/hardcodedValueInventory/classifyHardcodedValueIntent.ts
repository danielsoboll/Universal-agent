/**
 * Classify HARDCODED_VALUE_INVENTORY questions — no object-name hardcoding.
 */
import type {
  HardcodedValueContext,
  HardcodedValueQueryClassification,
  HardcodedValueType,
} from "./types";

const HARDCODED_CUE_RE =
  /\b(hart\s*codiert|hartcodiert|hard\s*cod(?:ed|ing)?|fest\s*(?:verdrahtet|codiert|im\s+code)|konstanten?|fest\s+im\s+code|stehen\s+fest)\b/i;

const LIST_CUE_RE =
  /\b(welche|welcher|welches|welchen|liste|wo\s+sind|gibt\s+es)\b/i;

const MATERIAL_RE =
  /\b(material(?:nummer(?:n)?)?|matnr|artikel(?:nummer(?:n)?)?)\b/i;
const CUSTOMER_RE =
  /\b(kunden(?:nummer(?:n)?)?|kunnr|debitor(?:en)?)\b/i;
const VENDOR_RE =
  /\b(lieferant(?:en)?(?:nummer(?:n)?)?|lifnr|kreditor(?:en)?)\b/i;
const PLANT_RE = /\b(werk(?:e|snummer)?|werks)\b/i;
const VALUE_RE =
  /\b(werte?|literale?|konstanten?|festwerte?)\b/i;

const PROCESS_RE =
  /\b(gesch.?ftsprozess(?:e)?|prozess(?:e)?|gesteuert|steuerung|auswirkung|verwendet)\b/i;

function detectValueType(q: string): {
  type: HardcodedValueType;
  cue: string | null;
} {
  if (MATERIAL_RE.test(q)) return { type: "MATERIAL_NUMBER", cue: "value:material" };
  if (CUSTOMER_RE.test(q)) return { type: "CUSTOMER_NUMBER", cue: "value:customer" };
  if (VENDOR_RE.test(q)) return { type: "VENDOR_NUMBER", cue: "value:vendor" };
  if (PLANT_RE.test(q)) return { type: "PLANT", cue: "value:plant" };
  if (VALUE_RE.test(q)) return { type: "GENERIC", cue: "value:generic" };
  return { type: "UNKNOWN", cue: null };
}

export function classifyHardcodedValueIntent(
  question: string,
): HardcodedValueQueryClassification {
  const q = question.trim();
  const matched_cues: string[] = [];
  const value = detectValueType(q);
  const hasHard = HARDCODED_CUE_RE.test(q);
  const hasList = LIST_CUE_RE.test(q);
  const hasProcess = PROCESS_RE.test(q);

  if (hasHard) matched_cues.push("hardcoded_cue");
  if (hasList) matched_cues.push("list_cue");
  if (value.cue) matched_cues.push(value.cue);
  if (hasProcess) matched_cues.push("process_cue");

  const requested_context: HardcodedValueContext = hasProcess
    ? "BUSINESS_PROCESS"
    : "NONE";

  // Strong: hardcoded cue + (material/customer/...) OR hardcoded + list + values
  const isHardcodedInventory =
    hasHard &&
    (value.type !== "UNKNOWN" ||
      (hasList && VALUE_RE.test(q)) ||
      (hasList && value.type === "GENERIC"));

  // Material-specific: "Materialnummern ... fest im Code / hart codiert"
  const materialHard =
    value.type === "MATERIAL_NUMBER" &&
    (hasHard || /\bfest\b/i.test(q) || /\bim\s+code\b/i.test(q));

  if (!isHardcodedInventory && !materialHard) {
    return {
      intent: "NOT_HARDCODED_VALUE",
      requested_value_type: value.type,
      requested_context,
      matched_cues,
    };
  }

  return {
    intent: "HARDCODED_VALUE_INVENTORY",
    requested_value_type:
      value.type === "UNKNOWN" ? "GENERIC" : value.type,
    requested_context,
    matched_cues,
  };
}

export function isHardcodedValueInventoryQuestion(question: string): boolean {
  return (
    classifyHardcodedValueIntent(question).intent ===
    "HARDCODED_VALUE_INVENTORY"
  );
}
