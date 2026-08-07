/**
 * Generische Query-Normalisierung für lexikalische DDIC-/Objektsuche.
 * Fragewörter werden entfernt, nicht als offene Konzepte behandelt.
 */
import {
  isQueryStopword,
  QUERY_STOPWORDS,
} from "@/lib/knowledge/queryStopwords";
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";
import type { NormalizedLexicalQuery } from "@/lib/search/lexical/types";

/** Häufige deutsche Komposita-Endungen (fachlich generisch, nicht kundenbezogen). */
const COMPOUND_TAILS = [
  "lager",
  "ort",
  "nummer",
  "schluessel",
  "schlüssel",
  "gruppe",
  "art",
  "typ",
  "status",
  "kennzeichen",
  "text",
  "name",
  "datum",
  "menge",
  "preis",
  "wert",
  "code",
  "klasse",
  "bereich",
  "stelle",
  "partner",
  "kunde",
  "material",
  "beleg",
  "position",
];

const ADJECTIVE_ENDINGS = ["es", "en", "em", "er", "e"];

function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .toLowerCase();
}

function tokenizeRaw(question: string): string[] {
  return question
    .split(/[^A-Za-zÄÖÜäöüß0-9_\/.-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Leichte deutsche Grundform: virtuelles → virtuell, Lagerorte → lagerort. */
export function germanStemLight(token: string): string {
  let t = fold(token);
  if (t.length < 4) return t;
  for (const end of ADJECTIVE_ENDINGS) {
    if (t.endsWith(end) && t.length - end.length >= 4) {
      const base = t.slice(0, -end.length);
      // Prefer stem ending in common adjective roots (…uell, …isch, …iv)
      if (/uell$|isch$|iv$|ig$|lich$/.test(base) || base.length >= 5) {
        t = base;
        break;
      }
    }
  }
  // Plural -e / -n already handled; strip trailing -s on longer nouns
  if (t.endsWith("s") && t.length >= 6 && !t.endsWith("ss")) {
    t = t.slice(0, -1);
  }
  return t;
}

export function splitCompoundParts(token: string): string[] {
  const t = fold(token);
  const parts = new Set<string>();
  if (t.length >= 4) parts.add(t);
  for (const tail of COMPOUND_TAILS) {
    const ft = fold(tail);
    if (t.length > ft.length + 3 && t.endsWith(ft)) {
      const head = t.slice(0, -ft.length);
      if (head.length >= 3) parts.add(head);
      parts.add(ft);
    }
  }
  // Underscore / hyphen splits
  for (const p of t.split(/[_./-]+/)) {
    if (p.length >= 3) parts.add(p);
  }
  return [...parts];
}

function isTechnicalToken(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (/^[A-Za-z][A-Za-z0-9_\/-]*-[A-Za-z0-9_\/-]+$/.test(t)) return true;
  if (/^(Z|Y|ZZ|YY)[A-Z0-9_\/-]{2,}$/i.test(t)) return true;
  if (/^[A-Z]{2,}[0-9A-Z_\/-]{2,}$/.test(t) && /[0-9_]/.test(t)) return true;
  if (/^[A-Z]{3,8}$/.test(t) && t === t.toUpperCase()) return true;
  return false;
}

/**
 * Normalisiert eine Nutzerfrage zu Phrasen, Inhaltswörtern und technischen Tokens.
 */
export function normalizeLexicalQuery(question: string): NormalizedLexicalQuery {
  const original = question.trim();
  const rawTokens = tokenizeRaw(original);
  const stopwords_removed: string[] = [];
  const contentSurface: string[] = [];
  const technical_tokens: string[] = [];

  for (const sym of extractTechnicalSymbols(original)) {
    technical_tokens.push(sym.raw);
    if (sym.norm !== sym.raw) technical_tokens.push(sym.norm);
  }

  for (const tok of rawTokens) {
    const lower = tok.toLowerCase();
    if (isQueryStopword(lower) || QUERY_STOPWORDS.has(fold(tok))) {
      stopwords_removed.push(lower);
      continue;
    }
    if (isTechnicalToken(tok)) {
      technical_tokens.push(tok.toUpperCase());
      continue;
    }
    contentSurface.push(tok);
  }

  const content_terms = [
    ...new Set(contentSurface.map((t) => germanStemLight(t)).filter((t) => t.length >= 3)),
  ];

  const stems = [...content_terms];
  const compound_parts = [
    ...new Set(contentSurface.flatMap((t) => splitCompoundParts(t))),
  ].filter((p) => p.length >= 3 && !isQueryStopword(p));

  // Phrasen: aufeinanderfolgende Inhaltswörter (Oberfläche + Stammvarianten)
  const phrases = new Set<string>();
  const surfaceContent = contentSurface.map((t) => t.toLowerCase());
  const stemmedContent = contentSurface.map((t) => germanStemLight(t));

  for (let n = 2; n <= Math.min(4, surfaceContent.length); n += 1) {
    for (let i = 0; i + n <= surfaceContent.length; i += 1) {
      const surfacePhrase = surfaceContent.slice(i, i + n).join(" ");
      const stemPhrase = stemmedContent.slice(i, i + n).join(" ");
      if (surfacePhrase.length >= 5) phrases.add(surfacePhrase);
      if (stemPhrase.length >= 5) phrases.add(stemPhrase);
      // Adjektivflexion nur bei typischen Adjektivstämmen
      if (n === 2) {
        const [a, b] = stemmedContent.slice(i, i + n);
        if (a && b && /uell$|isch$|iv$|ig$|lich$/.test(a)) {
          phrases.add(`${a}e ${b}`);
          phrases.add(`${a}es ${b}`);
          phrases.add(`${a}en ${b}`);
        }
      }
    }
  }

  // Längste Phrase zuerst in Diagnose / Matching
  const phraseList = [...phrases].sort((a, b) => b.length - a.length);

  return {
    original,
    phrases: phraseList,
    content_terms: [...new Set([...content_terms, ...compound_parts])].filter(
      (t) => t.length >= 3,
    ),
    technical_tokens: [...new Set(technical_tokens.map((t) => t.toUpperCase()))],
    stopwords_removed: [...new Set(stopwords_removed)],
    stems,
    compound_parts,
  };
}
