/**
 * Generic fallback for bare technical tokens (e.g. ZRAH) that lack
 * inventory/symbol hits but have literal or code-usage evidence.
 * No object-specific vocabulary.
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";
import {
  hasExactAuthoritativeFlag,
  isExactAuthoritativeHit,
  isTechnicalIdToken,
} from "@/lib/knowledge/exactAuthoritative";

const LITERAL_BUDGET = 12;
const CODE_USAGE_BUDGET = 12;
const GRAPH_NEIGHBOR_BUDGET = 8;
const MAX_FALLBACK_TOKENS = 4;

/**
 * Stricter than isTechnicalIdToken: SAP-like Z/Y names or structured
 * tokens with _/digits. Excludes soft all-caps German words (LAGER, …)
 * and names that already rely on inventory (OCTOPUS via partner_profile).
 */
export function isBareTechnicalFallbackToken(anchor: string): boolean {
  const u = anchor.trim().toUpperCase();
  if (!isTechnicalIdToken(u)) return false;
  if (/[_0-9]/.test(u)) return true;
  if (/^[ZY][A-Z0-9]{2,39}$/.test(u)) return true;
  return false;
}

export function isBareTechnicalUsageHit(hit: KnowledgeHit): boolean {
  if (hit.metadata?.bare_technical_usage === true) return true;
  if (hit.metadata?.portable_literal === true) return true;
  if (hit.metadata?.lexical_expand === "code_usage") return true;
  return (hit.matched_terms ?? []).some((t) => {
    const s = String(t).toLowerCase();
    return (
      s === "bare_technical_usage" ||
      s.startsWith("literal:") ||
      s.startsWith("code_ref:")
    );
  });
}

export function hasAuthoritativeDefinitionHits(
  hits: KnowledgeHit[],
  technicalAnchors: string[],
): boolean {
  return hits.some(
    (h) =>
      hasExactAuthoritativeFlag(h) ||
      isExactAuthoritativeHit(h, technicalAnchors),
  );
}

function hitMentionsToken(hit: KnowledgeHit, token: string): boolean {
  const needle = token.trim().toUpperCase();
  if (needle.length < 2) return false;
  const hay = [
    hit.title,
    hit.object_name,
    hit.subobject_name,
    hit.source_key,
    hit.snippet,
    hit.technical_summary,
    ...(hit.hardcoded_values ?? []),
    ...(hit.matched_terms ?? []),
    ...(hit.facts ?? []),
  ]
    .filter(Boolean)
    .join("\n")
    .toUpperCase();
  return hay.includes(needle);
}

/** Mark hits produced by the bare-token fallback path. */
export function markBareTechnicalUsageHit(hit: KnowledgeHit): KnowledgeHit {
  return {
    ...hit,
    metadata: { ...hit.metadata, bare_technical_usage: true },
    matched_terms: [
      ...new Set([...(hit.matched_terms ?? []), "bare_technical_usage"]),
    ],
  };
}

export function selectBareTechnicalFallbackTokens(
  anchors: string[],
  hasSymbolHits: (token: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const a of anchors) {
    if (!isBareTechnicalFallbackToken(a)) continue;
    if (hasSymbolHits(a)) continue;
    out.push(a.trim().toUpperCase());
    if (out.length >= MAX_FALLBACK_TOKENS) break;
  }
  return out;
}

export function tokensNeedingUsageFallback(params: {
  tokens: string[];
  existingHits: KnowledgeHit[];
}): string[] {
  return params.tokens.filter((token) => {
    if (
      params.existingHits.some(
        (h) =>
          hasExactAuthoritativeFlag(h) || isExactAuthoritativeHit(h, [token]),
      )
    ) {
      return false;
    }
    // Already have literal/code usage for this token → skip re-fetch
    if (
      params.existingHits.some(
        (h) => isBareTechnicalUsageHit(h) && hitMentionsToken(h, token),
      )
    ) {
      return false;
    }
    return true;
  });
}

export const BARE_TECHNICAL_FALLBACK_BUDGETS = {
  literals: LITERAL_BUDGET,
  code_usage: CODE_USAGE_BUDGET,
  graph_neighbors: GRAPH_NEIGHBOR_BUDGET,
  max_tokens: MAX_FALLBACK_TOKENS,
} as const;

/**
 * Deterministic answer when only code/literal usage exists — never invents
 * what the token "is".
 */
export function buildUsageOnlyDirectAnswer(params: {
  anchor: string;
  hits: KnowledgeHit[];
}): string {
  const anchor = params.anchor.trim().toUpperCase() || params.anchor;
  const usageHits = params.hits.filter(
    (h) => isBareTechnicalUsageHit(h) || hitMentionsToken(h, anchor),
  );
  const lines: string[] = [
    `Eine authoritative Definition von ${anchor} ist in den geladenen Quellen nicht belegt.`,
    `Im Code wird ${anchor} jedoch an folgenden Stellen verwendet:`,
  ];

  const seen = new Set<string>();
  for (const h of usageHits) {
    const obj = (h.object_name || "").trim();
    const sub = (h.subobject_name || "").trim();
    const loc = [obj, sub].filter(Boolean).join(" / ") || h.title || h.source_key;
    const preview = (
      h.snippet ||
      h.technical_summary ||
      (h.hardcoded_values ?? [])[0] ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    const key = `${loc}|${preview.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(preview ? `- ${loc}: ${preview}` : `- ${loc}`);
    if (seen.size >= 8) break;
  }

  if (seen.size === 0) {
    lines.push("- (keine konkreteren Verwendungsstellen im Trefferpack)");
  }
  return lines.join("\n");
}

export function shouldUseUsageOnlyAnswer(params: {
  hits: KnowledgeHit[];
  technicalAnchors: string[];
}): { apply: boolean; anchor: string | null } {
  const anchors = params.technicalAnchors.filter(isBareTechnicalFallbackToken);
  if (anchors.length === 0) return { apply: false, anchor: null };
  if (hasAuthoritativeDefinitionHits(params.hits, params.technicalAnchors)) {
    return { apply: false, anchor: null };
  }
  const hasUsage = params.hits.some(
    (h) =>
      isBareTechnicalUsageHit(h) &&
      anchors.some((a) => hitMentionsToken(h, a)),
  );
  if (!hasUsage) return { apply: false, anchor: null };
  return { apply: true, anchor: anchors[0]! };
}
