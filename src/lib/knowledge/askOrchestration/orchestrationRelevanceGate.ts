/**
 * Score and filter evidence candidates for PROCESS / TRACE answers.
 */
import type { GraphFirstRetrieval } from "./graphFirstRetrieval";
import type { AskOrchestrationIntent } from "./classifyAskIntent";
import {
  PROCESS_PRIMARY_OBJECT_TYPES,
  PROCESS_RESTRICTED_OBJECT_TYPES,
  type EvidenceCandidate,
  type RelevanceFlags,
} from "./relevanceGateTypes";

/** Collapse prefix duplicates: VIRTUE ⊂ VIRTUELL ⊂ VIRTUELLE. */
export function normalizeQueryTerms(terms: string[]): string[] {
  const upper = [
    ...new Set(
      terms
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t.length >= 4),
    ),
  ];
  return upper
    .filter(
      (t) =>
        !upper.some(
          (o) => o !== t && o.startsWith(t) && o.length > t.length,
        ),
    )
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function significantNameTokens(name: string): string[] {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 4);
}

export function queryTermCoverage(
  haystack: string,
  queryTerms: string[],
): number {
  const h = haystack.toUpperCase();
  let n = 0;
  for (const t of queryTerms) {
    if (h.includes(t)) n += 1;
  }
  return n;
}

function emptyFlags(overrides?: Partial<RelevanceFlags>): RelevanceFlags {
  return {
    exact_symbol_match: false,
    direct_edge_to_seed: false,
    graph_distance: null,
    authoritative_relation: false,
    same_code_unit: false,
    same_class_or_program: false,
    semantic_only: false,
    shared_token_only: false,
    ...overrides,
  };
}

function parseAuthNode(raw: string): { object_type: string; object_name: string } {
  const idx = raw.indexOf(":");
  if (idx < 0) return { object_type: "NODE", object_name: raw };
  return {
    object_type: raw.slice(0, idx).toUpperCase(),
    object_name: raw.slice(idx + 1),
  };
}

/**
 * Strong technical seeds = code objects covering ≥2 query terms,
 * or exact technical symbols from the question,
 * or best multi-term / distance-0 fallback.
 */
export function identifyStrongSeedObjects(params: {
  graph_paths: GraphFirstRetrieval["graph_paths"];
  technical_symbols: string[];
  query_terms: string[];
}): string[] {
  const terms = normalizeQueryTerms(params.query_terms);
  const symbols = [
    ...new Set(params.technical_symbols.map((s) => s.toUpperCase()).filter((s) => s.length >= 3)),
  ];
  const byObject = new Map<string, { coverage: number; minDist: number }>();
  for (const p of params.graph_paths) {
    const name = p.object_name.toUpperCase();
    const cov = queryTermCoverage(name, terms.length ? terms : symbols);
    const prev = byObject.get(name);
    if (!prev || cov > prev.coverage || p.distance < prev.minDist) {
      byObject.set(name, {
        coverage: Math.max(cov, prev?.coverage ?? 0),
        minDist: Math.min(p.distance, prev?.minDist ?? 99),
      });
    }
  }

  const strong: string[] = [];

  // Exact / token-identity matches for question symbols (prefer these)
  if (symbols.length > 0) {
    for (const [name, info] of byObject) {
      if (info.minDist > 1) continue;
      for (const sym of symbols) {
        if (
          name === sym ||
          name.endsWith(`_${sym}`) ||
          name.startsWith(`${sym}_`)
        ) {
          if (!strong.includes(name)) strong.push(name);
        }
      }
    }
    // Cap anchors: prefer shortest names (closer to the symbol itself)
    if (strong.length > 5) {
      strong.sort((a, b) => a.length - b.length || a.localeCompare(b));
      return strong.slice(0, 5);
    }
    // Always keep literal question symbols as anchors
    for (const sym of symbols) {
      if (!strong.includes(sym)) strong.unshift(sym);
    }
    if (strong.length > 0) return [...new Set(strong)].slice(0, 5);
  }

  const minCoverage = terms.length >= 2 ? 2 : 1;
  for (const [name, info] of byObject) {
    if (info.coverage >= minCoverage && info.minDist <= 1) {
      strong.push(name);
    }
  }

  for (const sym of symbols) {
    if (!strong.includes(sym) && byObject.has(sym)) strong.push(sym);
  }

  // Fallback: best single coverage object at distance 0
  if (strong.length === 0) {
    let best: { name: string; cov: number } | null = null;
    for (const [name, info] of byObject) {
      if (info.minDist > 0) continue;
      if (!best || info.coverage > best.cov) best = { name, cov: info.coverage };
    }
    if (best && best.cov >= 1) strong.push(best.name);
  }

  return strong;
}

function scoreCodeUnit(params: {
  object_name: string;
  unit_name: string;
  distance: number;
  path_relations: string[];
  source_key: string;
  strong_seeds: string[];
  technical_symbols: string[];
  query_terms: string[];
}): EvidenceCandidate {
  const obj = params.object_name.toUpperCase();
  const unit = params.unit_name.toUpperCase();
  const hay = `${obj}|${unit}|${params.source_key.toUpperCase()}`;
  const coverage = queryTermCoverage(obj, params.query_terms);
  const isStrong = params.strong_seeds.some(
    (s) => obj === s || obj.includes(s) || s.includes(obj),
  );
  const exact = params.technical_symbols.some(
    (s) =>
      hay.includes(s.toUpperCase()) ||
      obj === s.toUpperCase() ||
      unit === s.toUpperCase(),
  );
  const directEdge =
    (params.path_relations.length > 0 && params.distance <= 2) ||
    (isStrong && params.distance <= 1);

  // Shared token only: name overlaps a query term but is not a strong seed /
  // exact symbol / edged neighbor of the process anchor.
  const shared_token_only =
    coverage >= 1 &&
    !isStrong &&
    !exact &&
    !(params.path_relations.length > 0 && params.distance <= 2) &&
    params.strong_seeds.length > 0;

  const flags = emptyFlags({
    exact_symbol_match: exact,
    direct_edge_to_seed: directEdge,
    graph_distance: params.distance,
    authoritative_relation: false,
    same_code_unit: false,
    same_class_or_program: isStrong,
    semantic_only: false,
    shared_token_only,
  });

  let tier: EvidenceCandidate["tier"] = "EXCLUDED";
  let exclude_reason: string | null = null;

  if (shared_token_only) {
    tier = "EXCLUDED";
    exclude_reason = "shared_token_only ohne technische Beziehung";
  } else if (exact || isStrong || (directEdge && params.distance <= 1)) {
    tier = "PRIMARY";
  } else if (params.distance <= 2 && (directEdge || coverage >= 2)) {
    tier = "SECONDARY";
  } else {
    tier = "EXCLUDED";
    exclude_reason = "kein belastbarer Bezug zum Prozessanker";
  }

  return {
    id: `code:${params.source_key}`,
    kind: "CODE_UNIT",
    object_type: "CLASS",
    object_name: params.object_name,
    unit_name: params.unit_name,
    source_key: params.source_key,
    display: `${params.object_name}.${params.unit_name}`,
    path_relations: params.path_relations,
    summary: null,
    flags,
    tier,
    exclude_reason,
    query_term_coverage: coverage,
  };
}

function scoreAuthNode(params: {
  raw: string;
  strong_seeds: string[];
  technical_symbols: string[];
  query_terms: string[];
  /** Object names from accepted primary code units. */
  primary_objects: Set<string>;
  intent: AskOrchestrationIntent;
}): EvidenceCandidate {
  const { object_type, object_name } = parseAuthNode(params.raw);
  const nameU = object_name.toUpperCase();
  const coverage = queryTermCoverage(nameU, params.query_terms);
  const exact = params.technical_symbols.some(
    (s) => nameU === s.toUpperCase() || nameU.includes(s.toUpperCase()),
  );
  const restricted = PROCESS_RESTRICTED_OBJECT_TYPES.has(object_type);
  const primaryType = PROCESS_PRIMARY_OBJECT_TYPES.has(object_type);

  // Authoritative relation only if node name shares a significant token with a primary object
  // (not merely a query term like a customer name).
  let authoritative_relation = false;
  for (const seed of params.strong_seeds) {
    const seedToks = significantNameTokens(seed).filter((t) => t.length >= 5);
    if (seedToks.some((t) => nameU.includes(t))) {
      authoritative_relation = true;
      break;
    }
  }

  const shared_token_only =
    coverage >= 1 && !exact && !authoritative_relation;

  const flags = emptyFlags({
    exact_symbol_match: exact,
    direct_edge_to_seed: false,
    graph_distance: null,
    authoritative_relation,
    same_code_unit: false,
    same_class_or_program: false,
    semantic_only: false,
    shared_token_only,
  });

  let tier: EvidenceCandidate["tier"] = "EXCLUDED";
  let exclude_reason: string | null = null;

  if (params.intent === "PROCESS_EXPLANATION" || params.intent === "TECHNICAL_TRACE") {
    if (restricted) {
      if (shared_token_only || !authoritative_relation) {
        tier = "EXCLUDED";
        exclude_reason =
          "restricted object type ohne Pfad zum Prozessanker (shared_token_only)";
      } else {
        tier = "SECONDARY";
      }
    } else if (primaryType && (exact || authoritative_relation || coverage >= 2)) {
      tier = "PRIMARY";
    } else if (primaryType && coverage >= 1 && authoritative_relation) {
      tier = "SECONDARY";
    } else if (shared_token_only) {
      tier = "EXCLUDED";
      exclude_reason = "shared_token_only ohne technische Beziehung";
    } else {
      tier = "EXCLUDED";
      exclude_reason = "Objekttyp/Bezug nicht prozessrelevant";
    }
  } else if (shared_token_only && !exact) {
    tier = "EXCLUDED";
    exclude_reason = "shared_token_only ohne technische Beziehung";
  } else {
    tier = exact || authoritative_relation ? "PRIMARY" : "SECONDARY";
  }

  return {
    id: `auth:${params.raw}`,
    kind: "AUTHORITATIVE_NODE",
    object_type,
    object_name,
    unit_name: null,
    source_key: null,
    display: params.raw,
    path_relations: [],
    summary: null,
    flags,
    tier,
    exclude_reason,
    query_term_coverage: coverage,
  };
}

const TABLE_FIELD_RE =
  /\b([A-Z][A-Z0-9_]{1,16})[~-]([A-Z][A-Z0-9_]{1,30})\b/g;

const ABAP_NOISE_TABLE = new Set([
  "IF",
  "AND",
  "OR",
  "EQ",
  "NE",
  "LT",
  "GT",
  "FOR",
  "IN",
  "ME",
  "CS",
  "LS",
  "TO",
  "NOT",
  "SYST",
  "SY",
  "CONSTANTS",
  "VALUE",
  "TYPE",
  "DATA",
  "HEAD",
  "LINE",
  "NEW",
]);

function normalizeTableToken(table: string): string {
  return table.replace(
    /^(CS_|LS_|L_S_|I_S_|G_S_|C_S_|E_S_|LT_|IT_|IS_|WA_)/,
    "",
  );
}

/**
 * Extract TABLE-FIELD refs from method-symbol text related to strong seeds.
 */
export function extractFieldRefsFromGraph(params: {
  method_symbol_names: string[];
  strong_seeds: string[];
  query_terms: string[];
}): EvidenceCandidate[] {
  const seedToks = new Set<string>();
  for (const s of params.strong_seeds) {
    for (const t of significantNameTokens(s)) {
      if (t.length >= 4) seedToks.add(t);
    }
  }
  const querySet = new Set(params.query_terms.map((t) => t.toUpperCase()));

  const out: EvidenceCandidate[] = [];
  const seen = new Set<string>();

  for (const raw of params.method_symbol_names) {
    const text = raw.toUpperCase();
    const symbolRelated = [...seedToks].some((t) => text.includes(t));
    if (!symbolRelated) continue;

    TABLE_FIELD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TABLE_FIELD_RE.exec(text)) !== null) {
      let table = normalizeTableToken(m[1]!);
      const field = m[2]!;
      if (table.length < 3 || field.length < 3) continue;
      if (ABAP_NOISE_TABLE.has(table) || ABAP_NOISE_TABLE.has(field)) continue;
      if (querySet.has(table) || querySet.has(field)) continue;
      // Skip one-letter work-area prefixes (S_STATUS, E_…)
      if (/^[A-Z]_/.test(table)) continue;
      // Field/table must itself relate to the strong seed tokens
      const fieldRelated = [...seedToks].some(
        (t) => field.includes(t) || table.includes(t),
      );
      if (!fieldRelated) continue;

      const key = `${table}-${field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `field:${key}`,
        kind: "FIELD_REF",
        object_type: "FIELD",
        object_name: key,
        unit_name: null,
        source_key: null,
        display: key,
        path_relations: [],
        summary: "Referenz in Code-Symbol nahe Prozessanker",
        flags: emptyFlags({
          same_code_unit: true,
          direct_edge_to_seed: true,
          authoritative_relation: true,
        }),
        tier: "PRIMARY",
        exclude_reason: null,
        query_term_coverage: queryTermCoverage(key, params.query_terms),
      });
    }
  }
  return out;
}

export type RelevanceGateResult = {
  query_terms: string[];
  strong_seeds: string[];
  candidates_before: EvidenceCandidate[];
  accepted: EvidenceCandidate[];
  excluded: EvidenceCandidate[];
  excluded_shared_token_only: string[];
  accepted_paths: string[];
  filtered_graph_paths: GraphFirstRetrieval["graph_paths"];
  filtered_analyses: GraphFirstRetrieval["cached_analyses"];
  filtered_authoritative_nodes: string[];
  field_refs: EvidenceCandidate[];
};

export function applyOrchestrationRelevanceGate(params: {
  intent: AskOrchestrationIntent;
  query_terms: string[];
  technical_symbols: string[];
  graph: GraphFirstRetrieval;
  method_symbol_names?: string[];
}): RelevanceGateResult {
  const query_terms = normalizeQueryTerms(params.query_terms);
  const strong_seeds = identifyStrongSeedObjects({
    graph_paths: params.graph.graph_paths,
    technical_symbols: params.technical_symbols,
    query_terms,
  });

  const codeCandidates = params.graph.graph_paths.map((p) =>
    scoreCodeUnit({
      object_name: p.object_name,
      unit_name: p.unit_name,
      distance: p.distance,
      path_relations: p.path_relations,
      source_key: p.source_key,
      strong_seeds,
      technical_symbols: params.technical_symbols,
      query_terms,
    }),
  );

  const primaryObjects = new Set(
    codeCandidates
      .filter((c) => c.tier === "PRIMARY" || c.tier === "SECONDARY")
      .map((c) => c.object_name.toUpperCase()),
  );
  // Ensure strong seeds count as primary objects even if somehow filtered
  for (const s of strong_seeds) primaryObjects.add(s);

  const authCandidates = params.graph.authoritative_nodes.map((raw) =>
    scoreAuthNode({
      raw,
      strong_seeds,
      technical_symbols: params.technical_symbols,
      query_terms,
      primary_objects: primaryObjects,
      intent: params.intent,
    }),
  );

  const field_refs = extractFieldRefsFromGraph({
    method_symbol_names: params.method_symbol_names ?? [],
    strong_seeds,
    query_terms,
  });

  const candidates_before = [
    ...codeCandidates,
    ...authCandidates,
    ...field_refs,
  ];

  const accepted = candidates_before.filter((c) => c.tier !== "EXCLUDED");
  const excluded = candidates_before.filter((c) => c.tier === "EXCLUDED");
  const excluded_shared_token_only = excluded
    .filter(
      (c) =>
        c.flags.shared_token_only ||
        (c.exclude_reason ?? "").includes("shared_token_only"),
    )
    .map((c) => c.display);

  const acceptedCodeKeys = new Set(
    accepted
      .filter((c) => c.kind === "CODE_UNIT" && c.source_key)
      .map((c) => c.source_key!),
  );
  const acceptedObjects = new Set(
    accepted
      .filter((c) => c.kind === "CODE_UNIT")
      .map((c) => c.object_name.toUpperCase()),
  );

  const filtered_graph_paths = params.graph.graph_paths.filter((p) =>
    acceptedCodeKeys.has(p.source_key),
  );
  const filtered_analyses = params.graph.cached_analyses.filter(
    (a) =>
      acceptedCodeKeys.has(a.source_key) ||
      acceptedObjects.has(a.object_name.toUpperCase()),
  );
  const filtered_authoritative_nodes = accepted
    .filter((c) => c.kind === "AUTHORITATIVE_NODE")
    .map((c) => c.display);

  const accepted_paths = filtered_graph_paths
    .filter((p) => p.path_relations.length > 0 || p.distance === 0)
    .slice(0, 40)
    .map((p) =>
      p.path_relations.length
        ? `${p.object_name}.${p.unit_name} dist=${p.distance} via ${p.path_relations.join("→")}`
        : `${p.object_name}.${p.unit_name} dist=${p.distance} (direct)`,
    );

  return {
    query_terms,
    strong_seeds,
    candidates_before,
    accepted,
    excluded,
    excluded_shared_token_only: [...new Set(excluded_shared_token_only)].slice(
      0,
      80,
    ),
    accepted_paths,
    filtered_graph_paths,
    filtered_analyses,
    filtered_authoritative_nodes,
    field_refs,
  };
}
