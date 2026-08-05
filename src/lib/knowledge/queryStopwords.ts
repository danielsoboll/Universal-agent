/**
 * Shared German/English question stopwords for retrieval planning.
 * These steer intent/output form — never become search concepts.
 */
export const QUERY_STOPWORDS = new Set(
  [
    "wie",
    "was",
    "wo",
    "wer",
    "welche",
    "welcher",
    "welches",
    "warum",
    "wieso",
    "weshalb",
    "genau",
    "bitte",
    "mal",
    "denn",
    "eigentlich",
    "überhaupt",
    "nochmal",
    "wissen",
    "wir",
    "über",
    "der",
    "die",
    "das",
    "dem",
    "den",
    "des",
    "ein",
    "eine",
    "einer",
    "einem",
    "eines",
    "und",
    "oder",
    "mit",
    "ohne",
    "für",
    "von",
    "zu",
    "zum",
    "zur",
    "im",
    "in",
    "am",
    "an",
    "auf",
    "ist",
    "sind",
    "wird",
    "werden",
    "funktioniert",
    "funktionieren",
    "gibt",
    "es",
    "uns",
    "mir",
    "dir",
    "ihm",
    "ihr",
    "sich",
    "auch",
    "nur",
    "noch",
    "schon",
    "sehr",
    "mehr",
    "alle",
    "alles",
    "etwas",
    "nichts",
    "the",
    "a",
    "an",
    "of",
    "to",
    "how",
    "what",
    "does",
    "work",
    "exactly",
    "about",
    "we",
    "know",
    "do",
    "you",
  ].map((s) => s.toLowerCase()),
);

/** Object-type words guessed from natural language — soft context, not hard retrieval seeds when technical tokens exist. */
export const OBJECT_TYPE_SEED_WORDS = new Set(
  [
    "nachricht",
    "nachrichten",
    "message",
    "messages",
    "meldung",
    "meldungen",
    "tabelle",
    "tabellen",
    "table",
    "tables",
    "programm",
    "programme",
    "program",
    "klasse",
    "klassen",
    "class",
    "classes",
    "methode",
    "methoden",
    "method",
    "feld",
    "felder",
    "field",
    "fields",
    "baustein",
    "funktionsbaustein",
  ].map((s) => s.toLowerCase()),
);

export function isQueryStopword(token: string): boolean {
  return QUERY_STOPWORDS.has(token.trim().toLowerCase());
}

export function isObjectTypeSeedWord(token: string): boolean {
  const t = token.trim().toLowerCase();
  if (OBJECT_TYPE_SEED_WORDS.has(t)) return true;
  for (const w of OBJECT_TYPE_SEED_WORDS) {
    if (t === w || t.startsWith(w)) return true;
  }
  return false;
}

/** Drop stopwords and (optionally) soft object-type words from concept lists. */
export function filterRetrievalConcepts(
  concepts: string[],
  opts?: { dropObjectTypeWords?: boolean },
): string[] {
  const out: string[] = [];
  for (const raw of concepts) {
    const c = raw.trim();
    if (!c) continue;
    const lower = c.toLowerCase();
    if (isQueryStopword(lower)) continue;
    // Multi-word: drop if every token is stopword
    const parts = lower.split(/\s+/).filter(Boolean);
    if (parts.length > 0 && parts.every((p) => isQueryStopword(p))) continue;
    if (opts?.dropObjectTypeWords && isObjectTypeSeedWord(lower)) continue;
    // Strip leading/trailing stopwords from phrases
    const cleaned = parts.filter((p) => !isQueryStopword(p)).join(" ");
    if (!cleaned) continue;
    if (opts?.dropObjectTypeWords && isObjectTypeSeedWord(cleaned)) continue;
    out.push(c.includes(" ") ? cleaned : c);
  }
  return [...new Set(out)];
}
