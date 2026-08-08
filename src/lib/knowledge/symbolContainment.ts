/**
 * Generic technical symbol-name containment (alias candidate generation).
 *
 * When a confirmed technical anchor exists (exact symbol hit), scan the
 * symbol-index for longer names that contain the token (OCTOPUS → EDIOCTOPUS).
 *
 * Containment is candidate-only:
 * - no graph/alias edge persistence
 * - no authoritative claim that the variant "is" the seed
 * - exact authoritative / exact seed / deterministic relations stay higher
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";
import { isAuthoritativeInventoryType } from "@/lib/knowledge/exactAuthoritative";
import {
  fetchPortableEvidenceByIds,
  findPortableSymbolNamesContaining,
  lookupPortableSymbolRecords,
} from "@/lib/portableIndex/indexLoader";
import type { PortableSymbolRecord } from "@/lib/portableIndex/types";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";

export const SYMBOL_CONTAINMENT_BUDGETS = {
  max_seeds: 3,
  max_variants_per_seed: 8,
  max_total_hits: 12,
  /** Raw name matches above this → treat seed as too generic, skip. */
  max_raw_matches_before_abort: 36,
  scan_limit: 48,
  min_token_length: 5,
  min_token_length_with_digit_or_underscore: 4,
} as const;

/** Generic / high-fan-out tokens that must never drive containment. */
const CONTAINMENT_STOP_TOKENS = new Set(
  [
    "SAP",
    "INFO",
    "DATA",
    "TABLE",
    "FIELD",
    "CODE",
    "TYPE",
    "NAME",
    "TEXT",
    "USER",
    "SYSTEM",
    "CLIENT",
    "MANDT",
    "LAGER",
    "WARE",
    "MATERIAL",
    "CUSTOMER",
    "VENDOR",
    "ORDER",
    "ITEM",
    "HEADER",
    "STATUS",
    "FLAG",
    "KEY",
    "VALUE",
    "DESC",
    "BELEG",
    "BUKRS",
    "VKORG",
    "VTWEG",
    "SPART",
    "KUNNR",
    "MATNR",
    "LIFNR",
    "OBJECT",
    "CLASS",
    "METHOD",
    "FORM",
    "PROG",
    "PROGRAM",
    "FUNCTION",
    "MODULE",
    "EXIT",
    "CHECK",
    "SEND",
    "READ",
    "WRITE",
    "UPDATE",
    "DELETE",
    "INSERT",
    "SELECT",
    "FROM",
    "INTO",
    "WITH",
    "AND",
    "OR",
    "NOT",
    "TRUE",
    "FALSE",
    "NULL",
    "TEST",
    "DEMO",
    "TEMP",
    "TMP",
    "NEW",
    "OLD",
    "ALL",
    "ANY",
    "ONE",
    "TWO",
    "ID",
    "NR",
    "NUM",
    "NO",
    "YES",
    "ABS",
    "REL",
    "DOC",
    "MSG",
    "IDOC",
    "EDI",
    "RFC",
    "BAPI",
    "ALE",
    "XML",
    "JSON",
    "HTTP",
    "HTTPS",
    "URL",
    "API",
  ].map((s) => s.toUpperCase()),
);

export type SymbolContainmentVariant = {
  seed: string;
  variant_name: string;
  document_id: string;
  inventory: boolean;
};

export type SymbolContainmentResult = {
  hits: KnowledgeHit[];
  variants: SymbolContainmentVariant[];
  indexes_used: string[];
  warnings: string[];
  trace: Array<{
    seed: string;
    eligible: boolean;
    skip_reason?: string;
    raw_match_count: number;
    variants: Array<{
      name: string;
      document_id: string;
      inventory: boolean;
    }>;
  }>;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function upper(s: string): string {
  return s.trim().toUpperCase();
}

/**
 * Technically plausible containment seed — not a soft language word,
 * not a stop token, length-gated.
 */
export function isSymbolContainmentEligibleToken(token: string): boolean {
  const u = upper(token);
  if (!/^[A-Z][A-Z0-9_]*$/.test(u)) return false;
  if (CONTAINMENT_STOP_TOKENS.has(u)) return false;
  const hasDigitOrUnderscore = /[_0-9]/.test(u);
  const min = hasDigitOrUnderscore
    ? SYMBOL_CONTAINMENT_BUDGETS.min_token_length_with_digit_or_underscore
    : SYMBOL_CONTAINMENT_BUDGETS.min_token_length;
  if (u.length < min) return false;
  if (u.length > 40) return false;
  // Soft all-caps language words (KOMMUNIKATION, …) are not technical ids.
  if (!hasDigitOrUnderscore && !u.startsWith("Z") && !u.startsWith("Y")) {
    if (u.length > 10) return false;
  }
  return true;
}

/** True when needle appears inside a technical name segment (not free prose). */
export function nameContainsTechnicalToken(
  name: string,
  needle: string,
): boolean {
  const n = upper(name);
  const a = upper(needle);
  if (!n || !a || n === a) return false;
  if (!n.includes(a)) return false;
  // Prefer segment-level containment (EDIOCTOPUS, LS|EDIOCTOPUS, …).
  const segments = n.split(/[^A-Z0-9_]+/).filter(Boolean);
  if (segments.some((seg) => seg !== a && seg.includes(a))) return true;
  // Whole key is a single technical token containing the needle.
  return /^[A-Z0-9_]+$/.test(n) && n.includes(a);
}

function variantRankScore(params: {
  seed: string;
  name: string;
  rec: PortableSymbolRecord | null;
}): number {
  const seed = upper(params.seed);
  const name = upper(params.name);
  let s = 0;
  const segs = name.split(/[^A-Z0-9_]+/).filter(Boolean);
  if (segs.some((seg) => seg.endsWith(seed) || seg.startsWith(seed))) s += 40;
  if (segs.some((seg) => seg.includes(seed) && seg.length <= seed.length + 8)) {
    s += 20;
  }
  // Closer (shorter) names first.
  s += Math.max(0, 30 - Math.min(30, name.length - seed.length));
  if (params.rec) {
    if (
      isAuthoritativeInventoryType({
        object_type: params.rec.object_type,
        knowledge_unit_type: params.rec.knowledge_unit_type,
      })
    ) {
      s += 50;
    }
    if (upper(params.rec.object_name) === name) s += 10;
  }
  return s;
}

function symbolToHit(
  s: PortableSymbolRecord,
  rank: number,
  meta: Record<string, unknown>,
  matchedTerms: string[],
  doc: SearchDocument | null,
): KnowledgeHit {
  const snippet =
    (doc?.technical_summary || doc?.title || s.title || s.object_name || "").slice(
      0,
      240,
    );
  return {
    rank,
    search_document_id: s.document_id,
    source_key: s.source_key,
    title: doc?.title || s.title || s.object_name,
    knowledge_unit_type:
      doc?.knowledge_unit_type || s.knowledge_unit_type || "unknown",
    combined_score: 55,
    exact_score: 2,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: doc?.confidence ?? 0.7,
    matched_terms: matchedTerms,
    snippet,
    evidence_refs: [],
    facts: doc?.facts ?? [],
    inferences: doc?.inferences ?? [],
    metadata: {
      portable_symbol_thin: !doc,
      ...meta,
    },
    object_name: s.object_name,
    object_type: s.object_type,
    subobject_name: s.subobject_name ?? "",
    technical_summary: snippet,
    business_purpose: doc?.business_purpose ?? "",
    tables_read: doc?.tables_read ?? [],
    tables_written: doc?.tables_written ?? [],
    called_methods: doc?.called_methods ?? [],
    called_functions: doc?.called_functions ?? [],
    hardcoded_values: doc?.hardcoded_values ?? [],
    entities: doc?.entities ?? [],
    relations: doc?.relations ?? [],
    evidence: doc?.evidence ?? [],
    doc_confidence: doc?.confidence ?? 0.7,
  };
}

export function isSymbolContainmentHit(hit: KnowledgeHit): boolean {
  if (hit.metadata?.symbol_name_containment === true) return true;
  return (hit.matched_terms ?? []).some(
    (t) => String(t).toLowerCase() === "symbol_name_containment",
  );
}

/**
 * Expand confirmed exact seeds → contained technical symbol candidates.
 * Does not mutate graph; does not mark authoritative.
 */
export function expandSymbolContainmentFromSeeds(params: {
  projectId: string;
  confirmedSeeds: string[];
  dataRoot?: string;
  alreadySeenIds?: Set<string>;
}): SymbolContainmentResult {
  const indexes_used: string[] = [];
  const warnings: string[] = [];
  const hits: KnowledgeHit[] = [];
  const variants: SymbolContainmentVariant[] = [];
  const trace: SymbolContainmentResult["trace"] = [];
  const expansionSeen = new Set<string>();
  const alreadySeen = params.alreadySeenIds ?? new Set<string>();

  const seeds = [
    ...new Set(
      params.confirmedSeeds
        .map((s) => upper(s))
        .filter((s) => s.length >= 2),
    ),
  ].slice(0, SYMBOL_CONTAINMENT_BUDGETS.max_seeds);

  if (seeds.length === 0) {
    return { hits, variants, indexes_used, warnings, trace };
  }

  indexes_used.push("symbol-index/name-containment");

  for (const seed of seeds) {
    if (hits.length >= SYMBOL_CONTAINMENT_BUDGETS.max_total_hits) break;

    if (!isSymbolContainmentEligibleToken(seed)) {
      trace.push({
        seed,
        eligible: false,
        skip_reason: CONTAINMENT_STOP_TOKENS.has(seed)
          ? "stop_token"
          : "not_eligible_token",
        raw_match_count: 0,
        variants: [],
      });
      continue;
    }

    const found = findPortableSymbolNamesContaining({
      projectId: params.projectId,
      needle: seed,
      dataRoot: params.dataRoot,
      scanLimit: SYMBOL_CONTAINMENT_BUDGETS.scan_limit,
      excludeExact: true,
    });

    const technical = found.matches.filter((m) =>
      nameContainsTechnicalToken(m.name, seed),
    );

    if (
      technical.length >=
        SYMBOL_CONTAINMENT_BUDGETS.max_raw_matches_before_abort ||
      found.truncated
    ) {
      trace.push({
        seed,
        eligible: true,
        skip_reason: "fan_out_abort",
        raw_match_count: technical.length,
        variants: [],
      });
      warnings.push(
        `Symbol-Containment: Seed ${seed} übersprungen (Fan-out ${technical.length}${found.truncated ? "+" : ""}).`,
      );
      continue;
    }

    // Collect unique document ids with best name label per id.
    type Cand = {
      name: string;
      document_id: string;
      rec: PortableSymbolRecord | null;
      score: number;
    };
    const byId = new Map<string, Cand>();
    const allIds = [
      ...new Set(technical.flatMap((m) => m.document_ids)),
    ].slice(0, 80);
    const recs = lookupPortableSymbolRecords(
      params.projectId,
      allIds,
      params.dataRoot,
    );
    const recById = new Map(recs.map((r) => [r.document_id, r]));

    for (const m of technical) {
      for (const id of m.document_ids) {
        const rec = recById.get(id) ?? null;
        // Prefer a clean object_name label when available.
        const label =
          rec && nameContainsTechnicalToken(rec.object_name, seed)
            ? asString(rec.object_name).toUpperCase()
            : m.name;
        const score = variantRankScore({ seed, name: label, rec });
        const prev = byId.get(id);
        if (!prev || score > prev.score) {
          byId.set(id, { name: label, document_id: id, rec, score });
        }
      }
    }

    const ranked = [...byId.values()].sort((a, b) => b.score - a.score);
    // Prefer inventory; drop pure unknown noise when inventory exists.
    const inventoryFirst = [
      ...ranked.filter(
        (c) =>
          c.rec &&
          isAuthoritativeInventoryType({
            object_type: c.rec.object_type,
            knowledge_unit_type: c.rec.knowledge_unit_type,
          }),
      ),
      ...ranked.filter(
        (c) =>
          !(
            c.rec &&
            isAuthoritativeInventoryType({
              object_type: c.rec.object_type,
              knowledge_unit_type: c.rec.knowledge_unit_type,
            })
          ),
      ),
    ].slice(0, SYMBOL_CONTAINMENT_BUDGETS.max_variants_per_seed);

    const evidence = fetchPortableEvidenceByIds(
      params.projectId,
      inventoryFirst.map((c) => c.document_id),
      params.dataRoot,
    );

    const kept: SymbolContainmentResult["trace"][number]["variants"] = [];

    for (const c of inventoryFirst) {
      if (hits.length >= SYMBOL_CONTAINMENT_BUDGETS.max_total_hits) break;
      if (expansionSeen.has(c.document_id)) continue;
      if (!c.rec) continue;
      // Without inventory type, only keep if object_name clearly contains seed.
      const inventory = isAuthoritativeInventoryType({
        object_type: c.rec.object_type,
        knowledge_unit_type: c.rec.knowledge_unit_type,
      });
      if (
        !inventory &&
        !nameContainsTechnicalToken(c.rec.object_name, seed) &&
        !nameContainsTechnicalToken(c.name, seed)
      ) {
        continue;
      }

      expansionSeen.add(c.document_id);
      const doc = evidence.get(c.document_id) ?? null;
      const promote = alreadySeen.has(c.document_id);
      const meta = {
        symbol_name_containment: true,
        containment_seed: seed,
        containment_variant: c.name,
        containment_inventory: inventory,
        containment_promote_existing: promote,
        // Explicitly not an authoritative alias relation.
        containment_relation: "name_substring_candidate",
      };
      hits.push(
        symbolToHit(
          c.rec,
          hits.length + 1,
          meta,
          [
            "symbol_name_containment",
            `contain:${seed}→${c.name}`,
            `seed:${seed}`,
            `sym:${c.name}`,
          ],
          doc,
        ),
      );
      variants.push({
        seed,
        variant_name: c.name,
        document_id: c.document_id,
        inventory,
      });
      kept.push({
        name: c.name,
        document_id: c.document_id,
        inventory,
      });
    }

    trace.push({
      seed,
      eligible: true,
      raw_match_count: technical.length,
      variants: kept,
    });
  }

  if (hits.length > 0) {
    warnings.push(
      `Symbol-Containment: ${variants.length} technische Namens-Kandidaten (keine persistierte Alias-Kante).`,
    );
  }

  return { hits, variants, indexes_used, warnings, trace };
}

/**
 * Keep a small budget of containment candidates in synthesis when soft
 * filters would otherwise drop them. Never promotes them above exact hits
 * already present in primary.
 */
export function mergePreserveSymbolContainment(
  primary: KnowledgeHit[],
  allHits: KnowledgeHit[],
): KnowledgeHit[] {
  const contained = allHits.filter(isSymbolContainmentHit);
  if (contained.length === 0) return primary;
  const keep = contained.slice(0, SYMBOL_CONTAINMENT_BUDGETS.max_total_hits);
  const seen = new Set(primary.map((h) => h.search_document_id));
  const out = [...primary];
  for (const h of keep) {
    if (seen.has(h.search_document_id)) continue;
    seen.add(h.search_document_id);
    out.push(h);
  }
  return out.map((h, i) => ({ ...h, rank: i + 1 }));
}
