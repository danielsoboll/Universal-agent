/**
 * Detect set / inventory / aggregation questions.
 * Heuristic only — no OpenAI.
 */
import type {
  InventoryEntityDomain,
  InventoryQueryClassification,
  InventoryRequestedFilter,
  InventoryRequestedOutput,
} from "./types";

const INVENTORY_CUES: Array<{ re: RegExp; cue: string }> = [
  { re: /\bwelche\b/i, cue: "welche" },
  { re: /\bwelcher\b/i, cue: "welcher" },
  { re: /\bwelches\b/i, cue: "welches" },
  { re: /\bwelchen\b/i, cue: "welchen" },
  { re: /\bwie\s+viele\b/i, cue: "wie viele" },
  { re: /\bliste\s+alle\b/i, cue: "liste alle" },
  { re: /\balle\b/i, cue: "alle" },
  { re: /\bsämtliche\b/i, cue: "sämtliche" },
  { re: /\bdavon\b/i, cue: "davon" },
  { re: /\bwelche\s+davon\b/i, cue: "welche davon" },
  { re: /\bübersicht\b/i, cue: "Übersicht" },
  { re: /\binventar\b/i, cue: "Inventar" },
  { re: /\benumerat/i, cue: "Enumeration" },
];

const DOMAIN_SET_CUES: Array<{ re: RegExp; cue: string }> = [
  { re: /\bnachrichtenarten?\b/i, cue: "Nachrichtenarten" },
  { re: /\boutputarten?\b/i, cue: "Outputarten" },
  { re: /\bausgabearten?\b/i, cue: "Ausgabearten" },
  { re: /\btabellen\b/i, cue: "Tabellen" },
  { re: /\bprogramme\b/i, cue: "Programme" },
  { re: /\bschnittstellen\b/i, cue: "Schnittstellen" },
  { re: /\bliefernachrichten\b/i, cue: "Liefernachrichten" },
  { re: /\bnachrichten\b/i, cue: "Nachrichten" },
];

const DELIVERY_CUES: Array<{ re: RegExp; cue: string }> = [
  { re: /\bliefernachricht/i, cue: "Liefernachricht" },
  { re: /\blieferung/i, cue: "Lieferung" },
  { re: /\blieferschein/i, cue: "Lieferschein" },
  { re: /\bversand\b/i, cue: "Versand" },
  { re: /\bdelivery\b/i, cue: "delivery" },
  { re: /\bshipping\b/i, cue: "shipping" },
  { re: /\blieferavis\b/i, cue: "Lieferavis" },
  { re: /\bdesadv\b/i, cue: "DESADV" },
];

const EDI_FILTER_CUES: Array<{ re: RegExp; cue: string }> = [
  { re: /\bidoc\b/i, cue: "IDoc" },
  { re: /\bedi\b/i, cue: "EDI" },
  { re: /\bale\b/i, cue: "ALE" },
  { re: /\bper\s+idoc\b/i, cue: "per IDoc" },
  { re: /\büber\s+idoc\b/i, cue: "über IDoc" },
  { re: /\berzeugen\s+idocs?\b/i, cue: "erzeugen IDocs" },
  { re: /\bidocs?\s+erzeugen\b/i, cue: "IDocs erzeugen" },
];

function matchCues(
  question: string,
  defs: Array<{ re: RegExp; cue: string }>,
): string[] {
  const out: string[] = [];
  for (const d of defs) {
    if (d.re.test(question)) out.push(d.cue);
  }
  return out;
}

function detectDomain(question: string): {
  domain: InventoryEntityDomain;
  cues: string[];
} {
  const delivery = matchCues(question, DELIVERY_CUES);
  if (delivery.length > 0) {
    return { domain: "DELIVERY_OUTPUT", cues: delivery };
  }
  const generic = matchCues(question, DOMAIN_SET_CUES);
  if (generic.length > 0) {
    return { domain: "OUTPUT_GENERIC", cues: generic };
  }
  return { domain: "UNKNOWN", cues: [] };
}

function detectFilter(question: string): {
  filter: InventoryRequestedFilter;
  cues: string[];
} {
  const edi = matchCues(question, EDI_FILTER_CUES);
  if (edi.length > 0) return { filter: "IDOC_OR_EDI", cues: edi };
  return { filter: "ALL_MEDIA", cues: [] };
}

function requestedOutputs(
  filter: InventoryRequestedFilter,
): InventoryRequestedOutput[] {
  const base: InventoryRequestedOutput[] = [
    "total_count",
    "complete_list",
    "processing_chain",
  ];
  if (filter === "IDOC_OR_EDI") base.splice(1, 0, "filtered_count");
  return base;
}

/**
 * Classify whether the question must be answered via inventory aggregation
 * instead of Top-k direct search.
 */
export function classifyInventoryIntent(
  question: string,
): InventoryQueryClassification {
  const q = question.trim();
  const inventoryCues = matchCues(q, INVENTORY_CUES);
  const domainSetCues = matchCues(q, DOMAIN_SET_CUES);
  const { domain, cues: domainCues } = detectDomain(q);
  const { filter, cues: filterCues } = detectFilter(q);

  const isInventory =
    inventoryCues.length > 0 &&
    (domainSetCues.length > 0 ||
      domain === "DELIVERY_OUTPUT" ||
      /nachrichten|output|ausgabe|tabellen|programme|schnittstellen/i.test(q));

  // Strong delivery+EDI inventory pattern even without explicit "alle"
  const strongDeliveryInventory =
    domain === "DELIVERY_OUTPUT" &&
    filter === "IDOC_OR_EDI" &&
    /\bwelche\b/i.test(q);

  if (!isInventory && !strongDeliveryInventory) {
    return {
      intent: "NOT_INVENTORY",
      entity_domain: domain,
      requested_filter: "NONE",
      requested_output: [],
      matched_cues: [...inventoryCues, ...domainCues, ...filterCues],
    };
  }

  return {
    intent: "INVENTORY_AND_AGGREGATION",
    entity_domain: domain === "UNKNOWN" ? "OUTPUT_GENERIC" : domain,
    requested_filter: filter,
    requested_output: requestedOutputs(filter),
    matched_cues: [
      ...new Set([
        ...inventoryCues,
        ...domainSetCues,
        ...domainCues,
        ...filterCues,
      ]),
    ],
  };
}

export function isInventoryAggregationQuestion(question: string): boolean {
  return classifyInventoryIntent(question).intent === "INVENTORY_AND_AGGREGATION";
}
