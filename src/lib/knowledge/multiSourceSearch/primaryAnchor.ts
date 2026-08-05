/**
 * Primäranker-Erkennung aus Stammdaten- und Steuertabellen-Evidenz.
 * Generisch — keine Kundennamen oder fest verdrahtete Feldnamen.
 */
import { isZLikeField } from "@/lib/knowledge/multiSourceSearch/anchors";
import { EVIDENCE_SCORES } from "@/lib/knowledge/multiSourceSearch/evidenceScoring";
import type {
  MultiSourceSearchPlan,
  PrimaryAnchor,
  StageEvidenceItem,
} from "@/lib/knowledge/multiSourceSearch/types";
import { extractTechnicalSymbols } from "@/lib/search/technicalSymbols";

const GENERIC_FIELDS = new Set([
  "AUART",
  "VKORG",
  "VTWEG",
  "SPART",
  "WERKS",
  "LGORT",
  "MANDT",
  "BUKRS",
  "KUNNR",
  "MATNR",
  "LIFNR",
]);

export type FieldCandidate = {
  table_name: string;
  field_name: string;
  description: string;
  data_element?: string;
  domain?: string;
  score: number;
  match_type: string;
  business_concept?: string;
};

/** Normalisierte Suchvarianten aus Frage-Konzepten. */
const PRIMARY_CONCEPT_DENY = new Set([
  "alt",
  "neu",
  "sich",
  "wie",
  "was",
  "und",
  "der",
  "die",
  "das",
  "wissen",
  "wir",
  "über",
  "nachricht",
  "nachrichten",
  "message",
  "messages",
  "meldung",
  "genau",
  "funktioniert",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wortgrenzen für kurze Tokens — vermeidet „alt“ in „Alter“. */
function conceptMatchesText(text: string, concept: string): boolean {
  const c = concept.trim().toLowerCase();
  if (c.length < 3) return false;
  const lower = text.toLowerCase();
  if (c.length <= 4) {
    return new RegExp(`\\b${escapeRegex(c)}\\b`, "iu").test(lower);
  }
  return lower.includes(c);
}

export function conceptSearchVariants(concepts: string[], synonyms: string[]): string[] {
  const raw = [...concepts, ...synonyms];
  const out = new Set<string>();
  for (const token of raw) {
    const t = token.trim().toLowerCase();
    if (t.length < 3) continue;
    out.add(t);
    out.add(t.replace(/\s+/g, "_"));
    out.add(t.replace(/\s+/g, ""));
    // Wortbestandteile ≥4 Zeichen
    for (const part of t.split(/[^a-zäöüß0-9]+/u)) {
      if (part.length >= 4) out.add(part);
    }
  }
  return [...out];
}

function conceptMatchScore(
  blob: string,
  variants: string[],
): { score: number; concept?: string; match_type: string } {
  const lower = blob.toLowerCase();
  let best = 0;
  let bestConcept: string | undefined;
  let matchType = "none";

  for (const v of variants) {
    if (v.length < 3) continue;
    if (conceptMatchesText(lower, v)) {
      const s = v.length >= 6 ? 40 : 25;
      if (s > best) {
        best = s;
        bestConcept = v;
        matchType = v.includes("_") ? "normalized_token" : "concept_partial";
      }
    }
  }

  // Exakter Feldtext-Match
  for (const v of variants) {
    if (v.length >= 5 && lower === v) {
      return { score: 60, concept: v, match_type: "field_text_exact" };
    }
  }

  return { score: best, concept: bestConcept, match_type: matchType };
}

export function scoreMasterDataFieldCandidate(params: {
  table_name: string;
  field_name: string;
  description: string;
  data_element?: string;
  plan: MultiSourceSearchPlan;
}): FieldCandidate {
  const descBlob = `${params.description} ${params.data_element ?? ""}`;
  const nameBlob = params.field_name;
  const variants = conceptSearchVariants(
    params.plan.concepts,
    params.plan.synonym_candidates,
  );

  let score = 0;
  let match_type = "weak";
  let business_concept: string | undefined;

  if (isZLikeField(params.field_name)) score += 35;

  const descMatch = conceptMatchScore(descBlob, variants);
  score += descMatch.score;
  if (descMatch.concept) business_concept = descMatch.concept;
  if (descMatch.score >= 25) match_type = descMatch.match_type;

  const nameMatch = conceptMatchScore(nameBlob, variants);
  score += nameMatch.score * 0.8;
  if (nameMatch.score >= 25 && !business_concept) {
    business_concept = nameMatch.concept;
    match_type = "field_name_pattern";
  }

  // Feldname enthält typische technische Abkürzungen aus Synonymen
  for (const v of variants) {
    if (v.length >= 4 && nameBlob.toUpperCase().includes(v.toUpperCase().replace(/\s/g, "_"))) {
      score += 20;
      match_type = "field_name_contains_concept";
      break;
    }
  }

  if (GENERIC_FIELDS.has(params.field_name.toUpperCase()) && !isZLikeField(params.field_name)) {
    score += EVIDENCE_SCORES.UNSPECIFIC_STANDARD_FIELD;
  }

  return {
    table_name: params.table_name,
    field_name: params.field_name,
    description: params.description,
    data_element: params.data_element,
    score,
    match_type,
    business_concept,
  };
}

export function pickPrimaryAnchorFromFieldCandidates(
  candidates: FieldCandidate[],
): PrimaryAnchor | null {
  const viable = candidates
    .filter((c) => {
      if (c.score < 45 || !isZLikeField(c.field_name)) return false;
      if (
        c.business_concept &&
        PRIMARY_CONCEPT_DENY.has(c.business_concept.toLowerCase())
      ) {
        return false;
      }
      // Kurze Konzept-Treffer allein reichen nicht (z. B. „alt“ ohne Fachtext)
      if (
        c.match_type === "concept_partial" &&
        (c.business_concept?.length ?? 0) < 5
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.score - a.score);

  if (viable.length === 0) return null;

  const best = viable[0]!;
  return {
    anchor_type: "MASTER_DATA_BUSINESS_FIELD",
    table: best.table_name,
    field: best.field_name,
    description: best.description,
    business_concept: best.business_concept,
    match_type: best.match_type,
    confidence: Math.min(0.99, 0.55 + best.score / 120),
  };
}

export function detectPrimaryAnchorFromMasterHits(
  hits: StageEvidenceItem[],
  plan: MultiSourceSearchPlan,
): PrimaryAnchor | null {
  const candidates: FieldCandidate[] = [];

  for (const hit of hits) {
    const fromMdCorpus =
      hit.source === "master_data" ||
      (hit.source === "exact_symbol" &&
        Boolean(hit.field_name && hit.table_name));
    if (!fromMdCorpus || !hit.field_name || !hit.table_name) continue;
    if (hit.evidence_type === "MASTER_DATA_BUSINESS_FIELD" && hit.primary_anchor) {
      return hit.primary_anchor;
    }
    candidates.push(
      scoreMasterDataFieldCandidate({
        table_name: hit.table_name,
        field_name: hit.field_name,
        description: hit.summary || "",
        plan,
      }),
    );
  }

  return pickPrimaryAnchorFromFieldCandidates(candidates);
}

/**
 * True when exact-symbol stage already found a strong code hit for a
 * technical token from the question — weak CT concept matches must not override.
 */
export function hasStrongExactSymbolCodeHit(
  hits: StageEvidenceItem[],
  plan: MultiSourceSearchPlan,
): boolean {
  const symbols = extractTechnicalSymbols(plan.question).map((s) => s.norm);
  if (symbols.length === 0) return false;
  return hits.some((h) => {
    if (h.evidence_type !== "EXACT_CODE_USAGE" && h.rank_tier !== "exact") {
      return false;
    }
    if ((h.confidence ?? 0) < 0.9) return false;
    const blob = `${h.title} ${h.object_name ?? ""} ${h.summary}`.toUpperCase();
    return symbols.some((sym) => blob.includes(sym));
  });
}

/**
 * Primary anchor from exact code/object hits whose name contains a question symbol.
 * Generic semantic words ("Nachricht") must not compete with this.
 */
export function detectTechnicalSymbolPrimary(
  hits: StageEvidenceItem[],
  plan: MultiSourceSearchPlan,
): PrimaryAnchor | null {
  const symbols = extractTechnicalSymbols(plan.question);
  if (symbols.length === 0) return null;

  const symbolNorms = symbols.map((s) => s.norm);
  const nameHits = hits.filter((h) => {
    if (h.rank_tier !== "exact" && h.evidence_type !== "EXACT_CODE_USAGE") {
      return false;
    }
    const blob = `${h.object_name ?? ""} ${h.title}`.toUpperCase();
    return symbolNorms.some((sym) => blob.includes(sym));
  });
  if (nameHits.length === 0) return null;

  // Prefer name-contains over mere content match; prefer FM/program object names
  const scored = nameHits
    .map((h) => {
      const name = (h.object_name ?? h.title).toUpperCase();
      let score = h.confidence * 50;
      for (const sym of symbolNorms) {
        if (name === sym) score += 100;
        else if (name.includes(sym)) score += 80;
      }
      if (/FUNCTION|FUBa|function_modules/i.test(`${h.path_hint} ${h.object_type}`)) {
        score += 15;
      }
      if (/PROGRAM|programs/i.test(`${h.path_hint} ${h.object_type}`)) {
        score += 10;
      }
      return { h, score, name };
    })
    .sort((a, b) => b.score - a.score);

  const primarySym =
    symbolNorms.find((sym) =>
      scored.some((s) => s.name.includes(sym)),
    ) ?? symbolNorms[0]!;

  const objects = [
    ...new Set(
      scored
        .map((s) => s.h.object_name || s.h.title.split("·")[0]?.trim() || "")
        .filter((o) => o.length >= 3 && o.toUpperCase().includes(primarySym)),
    ),
  ].slice(0, 12);

  const top = scored[0]!.h;
  const userGuess = guessUserObjectType(plan.question);

  return {
    anchor_type: "TECHNICAL_SYMBOL",
    table: objects[0] || primarySym,
    symbol: primarySym,
    objects,
    object_type: top.object_type,
    description: `Technische Objekte mit ${primarySym} im Namen (${objects.length})`,
    business_concept: primarySym.toLowerCase(),
    match_type: "exact_symbol_object_name",
    user_object_type_guess: userGuess,
    confidence: 0.99,
  };
}

const GENERIC_OBJECT_TYPE_WORDS = [
  "nachricht",
  "message",
  "meldung",
  "idoc",
  "tabelle",
  "table",
  "klasse",
  "class",
  "programm",
  "program",
  "baustein",
  "funktion",
];

function guessUserObjectType(question: string): string | undefined {
  const lower = question.toLowerCase();
  for (const w of GENERIC_OBJECT_TYPE_WORDS) {
    if (new RegExp(`\\b${w}\\w*\\b`, "i").test(lower)) return w;
  }
  return undefined;
}

/** Discard semantic noise unless related to a technical symbol object. */
export function isGenericMessageNoise(
  item: StageEvidenceItem,
  symbolObjects: string[],
  symbols: string[],
): boolean {
  const blob = `${item.title} ${item.table_name ?? ""} ${item.object_name ?? ""} ${item.summary}`.toUpperCase();
  const related = [...symbolObjects, ...symbols].some((s) =>
    blob.includes(s.toUpperCase()),
  );
  if (related || item.related_to_symbol) return false;

  const generic = /\b(MESSAGE|MESSAGES|NACHRICHT|MELDUNG|NACHRICHTEN)\b/i.test(
    blob,
  );
  if (!generic) return false;

  // Exact symbol stage hits are never noise
  if (item.source === "exact_symbol" && item.rank_tier === "exact") return false;
  if (item.evidence_type === "EXACT_CODE_USAGE" && related) return false;

  return (
    item.evidence_type === "SEMANTIC_CANDIDATE" ||
    item.rank_tier === "semantic_weak" ||
    item.source === "control_tables" ||
    item.source === "master_data"
  );
}

function normalizeZTableName(raw: string): string | null {
  const trimmed = raw.trim();
  const m = trimmed.match(/(^|\s)([ZY][A-Z0-9_]{2,})/i);
  return m ? m[2].toUpperCase() : null;
}

export function detectControlTableAnchor(
  hits: StageEvidenceItem[],
  plan: MultiSourceSearchPlan,
): PrimaryAnchor | null {
  const variants = conceptSearchVariants(plan.concepts, plan.synonym_candidates);
  const strongVariants = variants.filter(
    (v) => v.length >= 5 && !PRIMARY_CONCEPT_DENY.has(v.toLowerCase()),
  );
  const techSymbols = extractTechnicalSymbols(plan.question).map((s) => s.norm);

  const zTables = hits
    .filter((h) => h.source === "control_tables" && h.rank_tier !== "semantic_weak")
    .map((hit) => {
      const tableName =
        normalizeZTableName(hit.table_name ?? "") ??
        normalizeZTableName(hit.title ?? "") ??
        normalizeZTableName(hit.summary ?? "");
      if (!tableName) return null;
      const blob = `${hit.title} ${hit.summary} ${tableName}`;
      let score = hit.confidence * 30;
      const match = conceptMatchScore(blob, strongVariants.length ? strongVariants : variants);
      score += match.score;
      // Tabellenname enthält Frage-Synonym (z. B. ZEXTO, OPTITOOL)
      for (const v of strongVariants) {
        if (tableName.toUpperCase().includes(v.toUpperCase().replace(/\s/g, "_"))) {
          score += 50;
        }
      }
      if (hit.rank_tier === "exact") score += 20;

      // Technical symbols in the question: CT without symbol mention cannot become primary.
      if (techSymbols.length > 0) {
        const upperBlob = blob.toUpperCase();
        const symHit = techSymbols.some(
          (sym) => upperBlob.includes(sym) || tableName.includes(sym),
        );
        if (symHit) score += 60;
        else return null;
      }

      return { hit, score, match, tableName };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score);

  if (zTables.length === 0) return null;

  const best = zTables[0]!;
  if (best.score < 35) return null;

  return {
    anchor_type: "CONTROL_TABLE",
    table: best.tableName,
    description: best.hit.summary,
    business_concept: best.match.concept,
    match_type: best.match.match_type,
    confidence: Math.min(0.92, 0.45 + best.score / 100),
  };
}

export function primaryAnchorNeedles(anchor: PrimaryAnchor): string[] {
  const needles: string[] = [];
  if (anchor.symbol) needles.push(anchor.symbol);
  for (const o of anchor.objects ?? []) needles.push(o);
  if (anchor.field) {
    needles.push(anchor.field);
    needles.push(`${anchor.table}-${anchor.field}`);
    needles.push(`${anchor.table}.${anchor.field}`);
    needles.push(`SELECT ${anchor.field} FROM ${anchor.table}`);
    needles.push(`${anchor.table}-${anchor.field}`);
  }
  if (anchor.table) needles.push(anchor.table);
  return [...new Set(needles.filter((n) => n.length >= 2))];
}
