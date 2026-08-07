/**
 * Extract named external application / interface / company / portal / system / partner
 * from a question — generic patterns, no customer-specific vocabulary.
 */
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";
import type { NamedExternalEntity } from "./types";

const STOP_NAMES = new Set(
  [
    "sap",
    "abap",
    "system",
    "portal",
    "schnittstelle",
    "firma",
    "partner",
    "anwendung",
    "nachricht",
    "idoc",
    "kunde",
    "kunden",
    "lager",
    "virtuelle",
    "virtuelles",
    "wie",
    "was",
    "welche",
    "welcher",
    "funktioniert",
    "wissen",
    "über",
  ].map((s) => s.toLowerCase()),
);

function normalizeName(s: string): string {
  return s
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function pushUnique(
  out: NamedExternalEntity[],
  raw: string,
  kind: NamedExternalEntity["kind"],
) {
  const trimmed = raw.trim().replace(/[?.!,;:]+$/g, "").trim();
  if (trimmed.length < 2) return;
  const normalized = normalizeName(trimmed);
  if (!normalized || STOP_NAMES.has(normalized)) return;
  if (out.some((e) => e.normalized === normalized)) return;
  out.push({ raw: trimmed, normalized, kind });
}

/**
 * Best single primary named external entity for anchoring (or null).
 * Prefers explicit cue patterns, then technical symbols (Z-names, EDIOCTOPUS).
 */
export function extractNamedExternalEntity(
  question: string,
): NamedExternalEntity | null {
  const all = extractNamedExternalEntities(question);
  if (all.length === 0) return null;
  // Prefer non-technical kinds when both present (e.g. "Edeka" over ZZ_VLAGER)
  const named = all.find((e) => e.kind !== "technical_symbol");
  return named ?? all[0]!;
}

export function extractNamedExternalEntities(
  question: string,
): NamedExternalEntity[] {
  const q = question.trim();
  const out: NamedExternalEntity[] = [];

  const patterns: Array<{ re: RegExp; kind: NamedExternalEntity["kind"] }> = [
    {
      re: /\b(?:schnittstelle|interface)\s+(?:zu\s+|nach\s+|mit\s+)?([A-ZÄÖÜ][\wÄÖÜäöüß.\-]{1,40})/gi,
      kind: "interface",
    },
    {
      re: /\b(?:portal)\s+([A-ZÄÖÜ][\wÄÖÜäöüß.\-]{1,40})/gi,
      kind: "portal",
    },
    {
      re: /\b(?:firma|unternehmen|marke)\s+([A-ZÄÖÜ][\wÄÖÜäöüß.\-]{1,40})/gi,
      kind: "company",
    },
    {
      re: /\b(?:partner|partnerprofil)\s+([A-ZÄÖÜA-Za-z0-9_][\wÄÖÜäöüß.\-]{1,40})/gi,
      kind: "partner",
    },
    {
      re: /\b(?:system|anwendung|applikation|app)\s+([A-ZÄÖÜA-Za-z0-9_][\wÄÖÜäöüß.\-]{1,40})/gi,
      kind: "system",
    },
    {
      re: /\büber\s+(?:die\s+nachricht\s+|das\s+|den\s+|die\s+)?([A-ZÄÖÜA-Za-z0-9_][\wÄÖÜäöüß.\-]{1,48})\s*\??$/i,
      kind: "application",
    },
    {
      re: /\b(?:bei|für|mit)\s+(?:dem\s+|der\s+|die\s+)?([A-ZÄÖÜ][\wÄÖÜäöüß]{2,}(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß]{2,}){0,2})\b/g,
      kind: "company",
    },
  ];

  for (const { re, kind } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(q))) {
      const cand = m[1]?.trim();
      if (!cand) continue;
      // Drop question leftovers
      if (/^(wir|wissen|funktioniert|genau)/i.test(cand)) continue;
      pushUnique(out, cand, kind);
    }
  }

  // Title-case / proper-name tokens (e.g. Edeka) — generic, stopword-filtered
  for (const m of q.matchAll(/\b([A-ZÄÖÜ][a-zäöüß]{3,})\b/g)) {
    pushUnique(out, m[1]!, "company");
  }

  // Bare technical symbols always count as anchors
  for (const sym of extractTechnicalSymbols(q)) {
    pushUnique(out, sym.raw, "technical_symbol");
  }

  // Whole-question uppercase token (e.g. "EDIOCTOPUS")
  const bare = q.match(/^([A-Z][A-Z0-9_]{2,})$/);
  if (bare?.[1]) pushUnique(out, bare[1], "technical_symbol");

  return out;
}

/** Technical needles derived from named entity + symbols in the question. */
export function namedEntityTechnicalAnchors(question: string): string[] {
  const entities = extractNamedExternalEntities(question);
  const out = new Set<string>();
  for (const e of entities) {
    out.add(e.raw.toUpperCase());
    out.add(e.normalized.toUpperCase().replace(/\s+/g, "_"));
    out.add(e.normalized.toUpperCase().replace(/\s+/g, ""));
  }
  for (const sym of extractTechnicalSymbols(question)) {
    out.add(sym.norm);
  }
  return [...out].filter((a) => a.length >= 2);
}
