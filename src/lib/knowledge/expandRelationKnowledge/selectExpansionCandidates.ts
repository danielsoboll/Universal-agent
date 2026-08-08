/**
 * Question-scoped code-unit selection for knowledge expansion.
 *
 * Ranks by shortest/strongest technical path to confirmed FIELD/object seeds.
 * Never ranks by cache-miss alone. No object-name hardcoding.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { hashUnitContent } from "@/lib/analysis/analyzeCodeUnits";
import { unitAnalysisRecordSchema } from "@/lib/analysis/unitAnalysisSchema";
import { evaluateUnitAnalysisCache } from "@/lib/analysis/unitAnalysisCache";
import {
  UNIT_ANALYSIS_PROMPT_VERSION,
  UNIT_ANALYSIS_SCHEMA_VERSION,
} from "@/lib/analysis/unitAnalysisSchema";
import { AI_CONFIG } from "@/lib/ai/config";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  loadClassAnalysesMap,
  loadCodeUnitIndex,
} from "@/lib/knowledge/graphSelector";
import type { CodeUnitIndex } from "@/lib/knowledge/graphSelector/loadGraph";
import type {
  CacheStatus,
  CodeUnitRef,
} from "@/lib/knowledge/graphSelector/types";
import { namedEntityTechnicalAnchors } from "@/lib/knowledge/searchBudget/extractNamedExternalEntity";
import { searchViaAccessIndexes } from "@/lib/portableIndex/accessIndexSearch";
import {
  enrichConfirmedFieldSeeds,
  parseFieldLikeSeeds,
} from "@/lib/knowledge/seedEnrichment";
import type { LocalProject } from "@/lib/localAuth/types";

export type ExpansionPriorityTier = 1 | 2 | 3 | 4;

export type ExpansionCandidate = {
  source_key: string;
  object_name: string;
  unit_name: string;
  unit_type: string;
  corpus: string;
  priority_tier: ExpansionPriorityTier;
  /** Higher = stronger relevance to confirmed seeds. */
  relevance_score: number;
  path_length: number;
  technical_path: string[];
  path_reason: string;
  selection_reason: string;
  cache_status: CacheStatus;
  would_need_openai: boolean;
  already_analyzed: boolean;
  matched_field_seeds: string[];
};

export type SelectExpansionCandidatesResult = {
  candidates: ExpansionCandidate[];
  field_seeds: string[];
  object_seeds: string[];
  confirmed_seeds: string[];
  notes: string[];
};

export type SelectExpansionCandidatesParams = {
  project: LocalProject;
  question: string;
  maxCandidates?: number;
  systemId?: string;
};

const FIELD_LINK_RELS = new Set([
  "CHECKS_FIELD",
  "READS_FIELD",
  "WRITES_FIELD",
  "REFERENCES_FIELD",
]);

function projectKeyOf(project: LocalProject): string {
  return project.customer_id?.trim() || "P01";
}

function fieldSeedsFromHits(
  hits: Array<{ title?: string; object_name?: string; source_key?: string }>,
): string[] {
  const out: string[] = [];
  for (const h of hits.slice(0, 40)) {
    const blob = `${h.title ?? ""} ${h.object_name ?? ""} ${h.source_key ?? ""}`;
    for (const m of blob.matchAll(
      /\b([A-Z][A-Z0-9_]{2,30})-(ZZ_[A-Z0-9_]+|[A-Z][A-Z0-9_]{2,30})\b/g,
    )) {
      out.push(`${m[1]}-${m[2]}`.toUpperCase());
    }
    for (const m of blob.matchAll(/\b(ZZ_[A-Z0-9_]{2,40})\b/g)) {
      out.push(m[1]!.toUpperCase());
    }
  }
  return [...new Set(out)];
}

function fieldTokens(fieldName: string): string[] {
  return significantNameTokens(fieldName);
}

/** Tokens + meaningful suffixes so ZZ_VLAGER aligns with ZCL_…_VIRTUELLES_LAGER. */
function significantNameTokens(name: string): string[] {
  const base = name
    .replace(/^ZZ_/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  const parts = base.split(/_+/).filter((t) => t.length >= 3);
  const out = new Set<string>();
  if (base.length >= 3) out.add(base);
  for (const p of parts) {
    out.add(p);
    // suffixes length ≥ 5 (VLAGER → LAGER; avoid tiny noise like AGER)
    for (let i = 1; i <= p.length - 5; i++) {
      out.add(p.slice(i));
    }
  }
  return [...out];
}

function objectSharesFieldTokens(objectName: string, tokens: string[]): number {
  const objectTokens = new Set(significantNameTokens(objectName));
  const o = objectName.toUpperCase();
  let hits = 0;
  for (const t of tokens) {
    if (t.length < 4) continue;
    if (o.includes(t) || objectTokens.has(t)) hits += 1;
  }
  return hits;
}

function sourceMentionsField(
  source: string,
  table: string | null,
  field: string,
): { hit: boolean; tableField: boolean; occurrences: number } {
  const upper = source.toUpperCase();
  const fieldU = field.toUpperCase();
  if (!upper.includes(fieldU)) {
    return { hit: false, tableField: false, occurrences: 0 };
  }
  let occurrences = 0;
  let idx = 0;
  while ((idx = upper.indexOf(fieldU, idx)) >= 0) {
    occurrences += 1;
    idx += fieldU.length;
  }
  let tableField = false;
  if (table) {
    const t = table.toUpperCase();
    if (upper.includes(`${t}-${fieldU}`) || upper.includes(`${t}~${fieldU}`)) {
      tableField = true;
    }
  }
  return { hit: true, tableField, occurrences };
}

type FieldSeed = {
  seed: string;
  table_name: string | null;
  field_name: string;
  tokens: string[];
};

type LinkHit = {
  source_key: string;
  relation: string;
  object_name: string;
  subobject_name: string;
  field_seed: string;
};

function loadAllFieldCodeLinks(params: {
  projectId: string;
  systemId: string;
  fields: FieldSeed[];
  cap?: number;
}): LinkHit[] {
  void params.systemId;
  const cap = params.cap ?? 400;
  const linksPath = path.join(
    getLocalDataRoot(),
    params.projectId,
    "canonical",
    "master-data",
    "customers",
    "links",
    "cross_source_links.jsonl",
  );
  if (!existsSync(linksPath)) return [];
  const out: LinkHit[] = [];
  const fieldNames = new Set(params.fields.map((f) => f.field_name));
  for (const line of readFileSync(linksPath, "utf8").split(/\r?\n/)) {
    if (!line.trim() || out.length >= cap) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const to = String(raw.to_entity_id ?? "");
    const rel = String(raw.link_type ?? "").toUpperCase();
    if (!FIELD_LINK_RELS.has(rel)) continue;
    const matchedField = [...fieldNames].find((f) => to.includes(`|${f}`));
    if (!matchedField) continue;
    const meta = (raw.metadata as Record<string, unknown>) ?? {};
    out.push({
      source_key: String(raw.source_key ?? ""),
      relation: rel,
      object_name: String(meta.object_name ?? ""),
      subobject_name: String(meta.subobject_name ?? ""),
      field_seed:
        params.fields.find((f) => f.field_name === matchedField)?.seed ??
        matchedField,
    });
  }
  return out;
}

function evaluateCache(
  ref: CodeUnitRef,
  analyses: Map<string, Record<string, unknown>>,
): {
  cache_status: CacheStatus;
  would_need_openai: boolean;
  already_analyzed: boolean;
} {
  if (ref.corpus !== "classes" || ref.unit_type !== "METHOD") {
    return {
      cache_status: "not_in_class_corpus",
      would_need_openai: false,
      already_analyzed: false,
    };
  }
  const raw = analyses.get(ref.source_key);
  const parsed = raw ? unitAnalysisRecordSchema.safeParse(raw) : null;
  const existing = parsed?.success ? parsed.data : undefined;
  const contentHash =
    ref.content_hash ??
    (ref.source_code ? hashUnitContent(ref.source_code) : undefined) ??
    existing?.content_hash ??
    "";
  if (!contentHash && !existing) {
    return {
      cache_status: "miss",
      would_need_openai: true,
      already_analyzed: false,
    };
  }
  const decision = evaluateUnitAnalysisCache({
    existing,
    source_key: ref.source_key,
    contentHash: contentHash || "missing-hash",
    promptVersion: UNIT_ANALYSIS_PROMPT_VERSION,
    model: AI_CONFIG.chatModel,
    analysisSchemaVersion: UNIT_ANALYSIS_SCHEMA_VERSION,
  });
  if (decision.hit) {
    return {
      cache_status: "hit",
      would_need_openai: false,
      already_analyzed: true,
    };
  }
  if (!existing) {
    return {
      cache_status: "miss",
      would_need_openai: true,
      already_analyzed: false,
    };
  }
  return {
    cache_status: "stale",
    would_need_openai: true,
    already_analyzed: true,
  };
}

function relationBonus(rel: string): number {
  const r = rel.toUpperCase();
  if (r.includes("WRITES")) return 120;
  if (r.includes("CHECKS")) return 100;
  if (r.includes("READS")) return 80;
  if (r.includes("REFERENCES")) return 60;
  return 40;
}

type Draft = {
  ref: CodeUnitRef;
  priority_tier: ExpansionPriorityTier;
  relevance_score: number;
  path_length: number;
  technical_path: string[];
  path_reason: string;
  selection_reason: string;
  matched_field_seeds: string[];
  core_object: boolean;
};

function buildCallAdjacency(
  analyses: Map<string, Record<string, unknown>>,
  byClassMethod: Map<string, CodeUnitRef[]>,
  methodsByUnitName: Map<string, CodeUnitRef[]>,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  for (const [sk, raw] of analyses) {
    const called = raw.called_methods;
    if (!Array.isArray(called)) continue;
    const className = String(raw.class_name ?? "").toUpperCase();
    for (const c of called) {
      const name = String(c ?? "").trim().toUpperCase();
      if (!name) continue;
      if (className) {
        const refs = byClassMethod.get(`${className}|${name}`);
        if (refs) {
          for (const r of refs) link(sk, r.source_key);
        }
      }
      const byUnit = methodsByUnitName.get(name);
      if (byUnit && byUnit.length === 1) {
        link(sk, byUnit[0]!.source_key);
      }
    }
  }
  return adj;
}

function indexClassMethods(codeUnits: CodeUnitIndex): {
  byClassMethod: Map<string, CodeUnitRef[]>;
  methodsByClass: Map<string, CodeUnitRef[]>;
  methodsByUnitName: Map<string, CodeUnitRef[]>;
} {
  const byClassMethod = codeUnits.byClassMethod;
  const methodsByClass = new Map<string, CodeUnitRef[]>();
  const methodsByUnitName = new Map<string, CodeUnitRef[]>();
  for (const ref of codeUnits.bySourceKey.values()) {
    if (ref.corpus !== "classes" || ref.unit_type !== "METHOD") continue;
    const cn = ref.object_name.toUpperCase();
    const un = ref.unit_name.toUpperCase();
    if (!methodsByClass.has(cn)) methodsByClass.set(cn, []);
    methodsByClass.get(cn)!.push(ref);
    if (!methodsByUnitName.has(un)) methodsByUnitName.set(un, []);
    methodsByUnitName.get(un)!.push(ref);
  }
  return { byClassMethod, methodsByClass, methodsByUnitName };
}

function methodCalledInSource(callerSrc: string, methodName: string): boolean {
  const src = callerSrc.toUpperCase();
  const meth = methodName.toUpperCase();
  return (
    src.includes(`->${meth}(`) ||
    src.includes(`=>${meth}(`) ||
    src.includes(` ${meth}(`) ||
    src.includes(`\n${meth}(`)
  );
}

/**
 * Select and rank expansion candidates. Does not call OpenAI.
 */
export async function selectExpansionCandidates(
  params: SelectExpansionCandidatesParams,
): Promise<SelectExpansionCandidatesResult> {
  const notes: string[] = [];
  const projectKey = projectKeyOf(params.project);
  const systemId = params.systemId || params.project.system_id || "D01";
  const maxCandidates = params.maxCandidates ?? 80;

  const access = searchViaAccessIndexes({
    project: params.project,
    query: params.question,
    limit: 48,
  });
  const hitSeeds = fieldSeedsFromHits(access?.hits ?? []);
  // Named-entity anchors (e.g. EDEKA) are NOT used as field needles for ranking —
  // they flood unrelated classes. Field-like seeds only drive code-unit selection.
  const questionAnchors = namedEntityTechnicalAnchors(params.question);
  const seedInput = [...new Set([...hitSeeds, ...questionAnchors])];
  const enrichment = enrichConfirmedFieldSeeds({
    projectId: projectKey,
    systemId,
    confirmedSeeds: seedInput,
    sampleLimit: 12,
  });

  // Primary field seeds = enrichment winners with evidence (not every Access-hit noise field).
  const enrichedPrimary = enrichment.field_enrichments.filter(
    (e) =>
      e.code_usage.total > 0 ||
      e.master_instances.total_attributes > 0 ||
      Boolean(e.ddic?.description),
  );
  const primarySeedStrings = enrichedPrimary.flatMap((e) => {
    const table = e.ddic?.table_name || e.seed.table_name;
    const field = e.ddic?.field_name || e.seed.field_name;
    return [
      e.seed.seed,
      table && field ? `${table}-${field}` : "",
      field || "",
    ].filter(Boolean);
  });

  const parsedFields = parseFieldLikeSeeds(
    primarySeedStrings.length > 0
      ? primarySeedStrings
      : [...hitSeeds, ...enrichment.confirmed_seeds],
  );

  const fields: FieldSeed[] = [];
  const seenField = new Set<string>();
  for (const f of parsedFields) {
    const key = `${f.table_name ?? "*"}|${f.field_name}`;
    if (seenField.has(key)) continue;
    seenField.add(key);
    fields.push({
      seed: f.seed,
      table_name: f.table_name,
      field_name: f.field_name,
      tokens: fieldTokens(f.field_name),
    });
  }

  // Prefer the enrichment-ranked lead field (first in pack) for scoring boosts.
  const leadFieldName =
    enrichedPrimary[0]?.ddic?.field_name ||
    enrichedPrimary[0]?.seed.field_name ||
    fields[0]?.field_name ||
    "";
  const leadTokens = new Set(fieldTokens(leadFieldName));

  if (fields.length === 0) {
    notes.push("Keine FIELD-Seeds für Expansion-Auswahl.");
    return {
      candidates: [],
      field_seeds: [],
      object_seeds: [],
      confirmed_seeds: seedInput,
      notes,
    };
  }

  const allTokens = [...new Set(fields.flatMap((f) => f.tokens))];
  notes.push(
    `Field-Seeds (primary enrichment): ${fields.map((f) => f.seed).join(", ")}; lead=${leadFieldName}; tokens=${allTokens.join(",")}`,
  );

  const [codeUnits, analyses] = await Promise.all([
    loadCodeUnitIndex(projectKey, { includeSourceCode: true }),
    Promise.resolve(loadClassAnalysesMap(projectKey)),
  ]);

  const { byClassMethod, methodsByClass, methodsByUnitName } =
    indexClassMethods(codeUnits);
  const callAdj = buildCallAdjacency(
    analyses,
    byClassMethod,
    methodsByUnitName,
  );

  const links = loadAllFieldCodeLinks({
    projectId: projectKey,
    systemId,
    fields,
    cap: 400,
  });
  notes.push(`Field code-links geladen: ${links.length}`);

  const drafts = new Map<string, Draft>();
  const upsert = (d: Draft) => {
    const prev = drafts.get(d.ref.source_key);
    if (!prev) {
      drafts.set(d.ref.source_key, d);
      return;
    }
    if (d.priority_tier < prev.priority_tier) {
      drafts.set(d.ref.source_key, {
        ...d,
        relevance_score: Math.max(d.relevance_score, prev.relevance_score),
      });
      return;
    }
    if (
      d.priority_tier === prev.priority_tier &&
      d.relevance_score > prev.relevance_score
    ) {
      drafts.set(d.ref.source_key, d);
    }
  };

  const p1Keys = new Set<string>();
  const linkByKey = new Map<string, LinkHit[]>();
  for (const l of links) {
    if (!l.source_key) continue;
    if (!linkByKey.has(l.source_key)) linkByKey.set(l.source_key, []);
    linkByKey.get(l.source_key)!.push(l);
  }

  for (const ref of codeUnits.bySourceKey.values()) {
    if (ref.corpus !== "classes" || ref.unit_type !== "METHOD") continue;
    const src = ref.source_code || "";
    if (!src && !linkByKey.has(ref.source_key)) continue;

    let best: {
      field: FieldSeed;
      tableField: boolean;
      occurrences: number;
      viaLink: LinkHit | null;
      scoreHint: number;
    } | null = null;

    for (const field of fields) {
      const mention = src
        ? sourceMentionsField(src, field.table_name, field.field_name)
        : { hit: false, tableField: false, occurrences: 0 };
      const viaLinks = (linkByKey.get(ref.source_key) || []).filter((l) => {
        const fs = l.field_seed.toUpperCase();
        return (
          fs === field.seed ||
          fs.endsWith(field.field_name) ||
          field.seed.endsWith(fs) ||
          fs.includes(field.field_name)
        );
      });
      const viaLink = viaLinks.sort(
        (a, b) => relationBonus(b.relation) - relationBonus(a.relation),
      )[0] ?? null;
      if (!mention.hit && !viaLink) continue;
      let scoreHint = mention.occurrences * 40;
      if (mention.tableField) scoreHint += 400;
      if (viaLink) scoreHint += relationBonus(viaLink.relation);
      const candidate = {
        field,
        tableField: mention.tableField,
        occurrences: mention.occurrences || (viaLink ? 1 : 0),
        viaLink,
        scoreHint,
      };
      if (!best || candidate.scoreHint > best.scoreHint) best = candidate;
    }

    if (!best) continue;

    const tokenHits = objectSharesFieldTokens(ref.object_name, allTokens);
    const leadTokenHits = objectSharesFieldTokens(ref.object_name, [
      ...leadTokens,
    ]);
    const core_object = leadTokenHits > 0 || tokenHits > 0;
    let score = 4000;
    // Seed-aligned object (generic token overlap with lead field) outranks peripheral P1.
    if (leadTokenHits > 0) score += 3000 + leadTokenHits * 300;
    else if (tokenHits > 0) score += 1500 + tokenHits * 150;
    // Prefer units that bind the lead field over secondary enriched fields.
    if (
      best.field.field_name === leadFieldName ||
      best.field.seed.includes(leadFieldName)
    ) {
      score += 800;
    }
    score += best.scoreHint;
    const path = [
      `SEED:${best.field.seed}`,
      best.viaLink
        ? best.viaLink.relation
        : best.tableField
          ? "DIRECT_TABLE_FIELD_IN_SOURCE"
          : "DIRECT_FIELD_IN_SOURCE",
      `${ref.object_name}/${ref.unit_name}`,
    ];
    upsert({
      ref,
      priority_tier: 1,
      relevance_score: score,
      path_length: 1,
      technical_path: path,
      path_reason: path.join(" → "),
      selection_reason: core_object
        ? `P1 direct field use in seed-aligned class (tokens=${tokenHits}); ${best.tableField ? "table-field" : "field"} in source${best.viaLink ? ` + ${best.viaLink.relation}` : ""}`
        : `P1 direct field use; ${best.tableField ? "table-field" : "field"} in source${best.viaLink ? ` + ${best.viaLink.relation}` : ""}`,
      matched_field_seeds: [best.field.seed],
      core_object,
    });
    p1Keys.add(ref.source_key);
  }

  const coreObjectSeeds = new Set<string>();
  const classP1Count = new Map<string, number>();
  for (const d of drafts.values()) {
    if (d.priority_tier !== 1) continue;
    const cn = d.ref.object_name.toUpperCase();
    classP1Count.set(cn, (classP1Count.get(cn) ?? 0) + 1);
    if (d.core_object) coreObjectSeeds.add(cn);
  }
  for (const l of links) {
    if (objectSharesFieldTokens(l.object_name, allTokens) > 0) {
      coreObjectSeeds.add(l.object_name.toUpperCase());
    }
  }
  for (const e of enrichment.field_enrichments) {
    for (const s of e.code_usage.samples) {
      if (objectSharesFieldTokens(s.object_name, allTokens) > 0) {
        coreObjectSeeds.add(s.object_name.toUpperCase());
      }
    }
    for (const name of e.graph_neighbor_names) {
      if (objectSharesFieldTokens(name, allTokens) > 0) {
        coreObjectSeeds.add(name.toUpperCase());
      }
    }
  }
  if (coreObjectSeeds.size === 0 && classP1Count.size > 0) {
    const top = [...classP1Count.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) coreObjectSeeds.add(top[0]);
  }

  notes.push(
    `Object-Seeds (field-token / P1 density): ${[...coreObjectSeeds].join(", ") || "—"}`,
  );

  // P2: methods in core object seeds with call/repo link to P1
  for (const className of coreObjectSeeds) {
    const methods = methodsByClass.get(className) || [];
    for (const ref of methods) {
      if (p1Keys.has(ref.source_key)) continue;
      const neighbors = callAdj.get(ref.source_key);
      let linkedP1: string | null = null;
      if (neighbors) {
        for (const n of neighbors) {
          if (p1Keys.has(n)) {
            linkedP1 = n;
            break;
          }
        }
      }
      if (!linkedP1) {
        for (const p1 of p1Keys) {
          const p1Ref = codeUnits.bySourceKey.get(p1);
          if (!p1Ref || p1Ref.object_name.toUpperCase() !== className) continue;
          if (methodCalledInSource(p1Ref.source_code || "", ref.unit_name)) {
            linkedP1 = p1;
            break;
          }
        }
      }
      if (!linkedP1) continue;
      const p1Ref = codeUnits.bySourceKey.get(linkedP1);
      const path = [
        `SEED:${fields[0]?.seed ?? "FIELD"}`,
        `P1:${p1Ref?.object_name ?? "?"}/${p1Ref?.unit_name ?? linkedP1}`,
        "CALL_OR_REPO_RELATION",
        `${ref.object_name}/${ref.unit_name}`,
      ];
      upsert({
        ref,
        priority_tier: 2,
        // Below seed-aligned P1 (~82xx), above peripheral P1 (~5xxx).
        relevance_score: 7000,
        path_length: 2,
        technical_path: path,
        path_reason: path.join(" → "),
        selection_reason:
          "P2 same seed-aligned class + call/repo link to P1 method",
        matched_field_seeds: fields.map((f) => f.seed).slice(0, 3),
        core_object: true,
      });
    }
  }

  const p12Keys = new Set(
    [...drafts.values()]
      .filter((d) => d.priority_tier <= 2)
      .map((d) => d.ref.source_key),
  );

  // P3: caller/callee of P1/P2
  for (const sk of p12Keys) {
    const neighbors = callAdj.get(sk);
    if (!neighbors) continue;
    for (const n of neighbors) {
      if (drafts.has(n)) continue;
      const ref = codeUnits.bySourceKey.get(n);
      if (!ref || ref.unit_type !== "METHOD") continue;
      const parent = drafts.get(sk);
      const path = [
        ...(parent?.technical_path ?? [`SEED:${fields[0]?.seed}`]),
        "CALLER_CALLEE",
        `${ref.object_name}/${ref.unit_name}`,
      ];
      upsert({
        ref,
        priority_tier: 3,
        relevance_score: 2000,
        path_length: (parent?.path_length ?? 1) + 1,
        technical_path: path,
        path_reason: path.join(" → "),
        selection_reason: "P3 caller/callee of P1/P2",
        matched_field_seeds: parent?.matched_field_seeds ?? [],
        core_object: objectSharesFieldTokens(ref.object_name, allTokens) > 0,
      });
    }
  }

  // P4: remaining field-link rows not elevated
  for (const [sk, ls] of linkByKey) {
    if (drafts.has(sk)) continue;
    const ref = codeUnits.bySourceKey.get(sk);
    if (!ref || ref.unit_type !== "METHOD") continue;
    const bestLink = [...ls].sort(
      (a, b) => relationBonus(b.relation) - relationBonus(a.relation),
    )[0]!;
    const path = [
      `SEED:${bestLink.field_seed}`,
      bestLink.relation,
      `${ref.object_name}/${ref.unit_name}`,
    ];
    upsert({
      ref,
      priority_tier: 4,
      relevance_score: 1000 + relationBonus(bestLink.relation),
      path_length: 2,
      technical_path: path,
      path_reason: path.join(" → "),
      selection_reason: `P4 field-link only (${bestLink.relation}); not elevated to P1–P3`,
      matched_field_seeds: [bestLink.field_seed],
      core_object: false,
    });
  }

  const ranked = [...drafts.values()].sort((a, b) => {
    // Strongest technical path first (score encodes P1-core > P2 > P1-peripheral > P3/P4).
    if (a.relevance_score !== b.relevance_score) {
      return b.relevance_score - a.relevance_score;
    }
    if (a.priority_tier !== b.priority_tier) {
      return a.priority_tier - b.priority_tier;
    }
    if (a.path_length !== b.path_length) {
      return a.path_length - b.path_length;
    }
    if (a.core_object !== b.core_object) return a.core_object ? -1 : 1;
    return a.ref.source_key.localeCompare(b.ref.source_key);
  });

  const candidates: ExpansionCandidate[] = ranked
    .slice(0, maxCandidates)
    .map((d) => {
      const cache = evaluateCache(d.ref, analyses);
      return {
        source_key: d.ref.source_key,
        object_name: d.ref.object_name,
        unit_name: d.ref.unit_name,
        unit_type: d.ref.unit_type,
        corpus: d.ref.corpus,
        priority_tier: d.priority_tier,
        relevance_score: d.relevance_score,
        path_length: d.path_length,
        technical_path: d.technical_path,
        path_reason: d.path_reason,
        selection_reason: d.selection_reason,
        cache_status: cache.cache_status,
        would_need_openai: cache.would_need_openai,
        already_analyzed: cache.already_analyzed,
        matched_field_seeds: d.matched_field_seeds,
      };
    });

  return {
    candidates,
    field_seeds: fields.map((f) => f.seed),
    object_seeds: [...coreObjectSeeds],
    confirmed_seeds: seedInput,
    notes,
  };
}
