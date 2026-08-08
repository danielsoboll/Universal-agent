/**
 * Deterministic 1-hop config/table expansion from confirmed technical seeds.
 * Uses existing control-table definitions (TABLE_HAS_FIELD) + portable symbol/
 * evidence docs — no semantic broadening, no rebuilds.
 */
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import type { KnowledgeHit } from "@/lib/knowledge/types";
import { parseFieldLikeSeeds } from "@/lib/knowledge/seedEnrichment/enrichConfirmedFieldSeeds";
import {
  fetchPortableEvidenceByIds,
  lookupPortableGraphNeighbors,
  lookupPortableSymbolRecords,
  lookupPortableSymbols,
} from "@/lib/portableIndex/indexLoader";
import type { PortableSymbolRecord } from "@/lib/portableIndex/types";
import type { SearchDocument } from "@/lib/search/searchDocumentSchema";

export const CONFIG_TABLE_EXPANSION_BUDGETS = {
  max_seeds: 6,
  max_tables_per_seed: 8,
  max_rows_per_table: 6,
  max_profiles: 8,
  max_total_hits: 24,
} as const;

export type ConfigTableLink = {
  table_name: string;
  field_name: string;
  relation_type: "TABLE_HAS_FIELD" | "GRAPH_TABLE_NEIGHBOR";
  field_is_key: boolean;
  seed: string;
};

export type ConfigTableExpansionResult = {
  hits: KnowledgeHit[];
  links: ConfigTableLink[];
  indexes_used: string[];
  warnings: string[];
  trace: Array<{
    seed: string;
    relation_type: string;
    table_name: string;
    candidate_ids: string[];
  }>;
};

type FieldTableDef = {
  table_name: string;
  field_is_key: boolean;
};

const fieldIndexCache = new Map<
  string,
  { mtimeMs: number; byField: Map<string, FieldTableDef[]> }
>();

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function definitionsPath(projectId: string, dataRoot?: string): string {
  const root = dataRoot ?? getLocalDataRoot();
  return path.join(
    root,
    projectId,
    "canonical",
    "control-tables",
    "table_definitions.jsonl",
  );
}

/** Lazy inverted index: FIELD_NAME → tables that declare that field (1-hop DDIC). */
export function loadFieldToTablesIndex(
  projectId: string,
  dataRoot?: string,
): Map<string, FieldTableDef[]> {
  const abs = definitionsPath(projectId, dataRoot);
  let mtimeMs = 0;
  try {
    if (existsSync(abs)) {
      mtimeMs = statSync(abs).mtimeMs;
    }
  } catch {
    mtimeMs = 0;
  }
  const cached = fieldIndexCache.get(projectId);
  if (cached && cached.mtimeMs === mtimeMs) return cached.byField;

  const byField = new Map<string, FieldTableDef[]>();
  if (!existsSync(abs)) {
    fieldIndexCache.set(projectId, { mtimeMs, byField });
    return byField;
  }

  for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const table_name = asString(raw.table_name).toUpperCase();
    if (!table_name) continue;
    const fields = Array.isArray(raw.fields) ? raw.fields : [];
    const keyFields = new Set(
      (Array.isArray(raw.key_fields) ? raw.key_fields : [])
        .map((k) => asString(k).toUpperCase())
        .filter(Boolean),
    );
    for (const f of fields) {
      if (!f || typeof f !== "object") continue;
      const field_name = asString(
        (f as Record<string, unknown>).field_name,
      ).toUpperCase();
      if (!field_name || field_name.length < 2) continue;
      const field_is_key =
        Boolean((f as Record<string, unknown>).key) || keyFields.has(field_name);
      const list = byField.get(field_name) ?? [];
      if (!list.some((x) => x.table_name === table_name)) {
        list.push({ table_name, field_is_key });
        byField.set(field_name, list);
      }
    }
  }

  fieldIndexCache.set(projectId, { mtimeMs, byField });
  return byField;
}

function isConfigInventorySymbol(s: PortableSymbolRecord): boolean {
  const kut = String(s.knowledge_unit_type ?? "").toLowerCase();
  const ot = String(s.object_type ?? "").toUpperCase();
  if (kut === "table_row" || kut === "table_profile") return true;
  if (ot === "TABLE_ROW" || ot === "TABLE" || ot === "TABLE_PROFILE") return true;
  return false;
}

function rowMentionsField(
  s: PortableSymbolRecord | SearchDocument,
  field: string,
): boolean {
  const f = field.toUpperCase();
  const blob = [
    (s as PortableSymbolRecord).title,
    (s as SearchDocument).title,
    (s as PortableSymbolRecord).source_key,
    (s as SearchDocument).source_key,
    (s as PortableSymbolRecord).object_name,
    (s as SearchDocument).object_name,
    (s as SearchDocument).search_text,
  ]
    .filter(Boolean)
    .join("\n")
    .toUpperCase();
  if (!blob.includes(f)) return false;
  // Prefer structured proximity: FIELD= / |FIELD= / -FIELD
  if (blob.includes(`${f}=`) || blob.includes(`|${f}`) || blob.includes(`-${f}`)) {
    return true;
  }
  return new RegExp(`(?:^|[^A-Z0-9_])${f}(?:[^A-Z0-9_]|$)`).test(blob);
}

function symbolToHit(
  s: PortableSymbolRecord,
  rank: number,
  meta: Record<string, unknown>,
  terms: string[],
  doc?: SearchDocument | null,
): KnowledgeHit {
  const title = doc?.title || s.title || s.object_name;
  const snippet = (
    doc?.technical_summary ||
    doc?.search_text ||
    s.title ||
    s.object_name
  ).slice(0, 400);
  return {
    rank,
    search_document_id: s.document_id,
    source_key: s.source_key,
    title,
    knowledge_unit_type: s.knowledge_unit_type || "table_row",
    combined_score: 70,
    exact_score: 3,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 2,
    confidence_bonus: 0.4,
    confidence: 0.85,
    matched_terms: [...new Set(terms)],
    snippet,
    evidence_refs: [s.source_key].filter(Boolean),
    facts: doc?.facts ?? [],
    inferences: doc?.inferences ?? [],
    metadata: {
      ...(doc?.metadata ?? {}),
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
    doc_confidence: doc?.confidence ?? 0.85,
  };
}

export function isConfigTableExpansionHit(hit: KnowledgeHit): boolean {
  if (hit.metadata?.config_table_expansion === true) return true;
  return (hit.matched_terms ?? []).some(
    (t) => String(t).toLowerCase() === "config_table_expansion",
  );
}

/**
 * Expand confirmed seeds → related control/config tables (1-hop) →
 * table_profile / table_row candidates already present in Access Indices.
 */
export function expandConfigTablesFromSeeds(params: {
  projectId: string;
  confirmedSeeds: string[];
  dataRoot?: string;
  alreadySeenIds?: Set<string>;
}): ConfigTableExpansionResult {
  const indexes_used: string[] = [];
  const warnings: string[] = [];
  const links: ConfigTableLink[] = [];
  const trace: ConfigTableExpansionResult["trace"] = [];
  const hits: KnowledgeHit[] = [];
  // Deduplicate within this expansion only. Caller remarques already-seen
  // Access hits with config_table_expansion metadata (seed proximity).
  const expansionSeen = new Set<string>();
  const alreadySeen = params.alreadySeenIds ?? new Set<string>();

  const seeds = [...new Set(params.confirmedSeeds.map((s) => s.trim()).filter(Boolean))]
    .slice(0, CONFIG_TABLE_EXPANSION_BUDGETS.max_seeds);
  if (seeds.length === 0) {
    return { hits, links, indexes_used, warnings, trace };
  }

  const fieldSeeds = parseFieldLikeSeeds(seeds);
  const fieldIndex = loadFieldToTablesIndex(params.projectId, params.dataRoot);
  if (fieldSeeds.length > 0) {
    indexes_used.push("canonical/control-tables/table_definitions");
  }

  const tableJobs: Array<{
    seed: string;
    field_name: string;
    table_name: string;
    relation_type: ConfigTableLink["relation_type"];
    field_is_key: boolean;
  }> = [];
  const seenTables = new Set<string>();

  for (const fs of fieldSeeds) {
    const defs = fieldIndex.get(fs.field_name.toUpperCase()) ?? [];
    const ranked = [...defs].sort(
      (a, b) => Number(b.field_is_key) - Number(a.field_is_key),
    );
    for (const d of ranked.slice(
      0,
      CONFIG_TABLE_EXPANSION_BUDGETS.max_tables_per_seed,
    )) {
      // Skip the seed's own master table when seed is TABLE-FIELD (KNVV-ZZ_VLAGER
      // → do not re-add KNVV as "config"); keep Z* control tables.
      if (
        fs.table_name &&
        d.table_name === fs.table_name.toUpperCase() &&
        !/^Z/i.test(d.table_name)
      ) {
        continue;
      }
      if (seenTables.has(d.table_name)) continue;
      seenTables.add(d.table_name);
      tableJobs.push({
        seed: fs.seed,
        field_name: fs.field_name,
        table_name: d.table_name,
        relation_type: "TABLE_HAS_FIELD",
        field_is_key: d.field_is_key,
      });
    }
  }

  // Graph 1-hop: TABLE neighbors of confirmed seeds (when edges exist).
  indexes_used.push("graph-index/config-1hop");
  const g = lookupPortableGraphNeighbors({
    projectId: params.projectId,
    seedNames: seeds,
    maxNeighborsPerSeed: 20,
    dataRoot: params.dataRoot,
  });
  for (const n of g.neighbor_nodes) {
    const ot = String(n.object_type ?? "").toUpperCase();
    const name = asString(n.object_name).toUpperCase();
    if (!name || (ot !== "TABLE" && ot !== "TABLE_PROFILE" && ot !== "DDIC_TABLE")) {
      continue;
    }
    const seed =
      seeds.find((s) =>
        g.edges.some(
          (e) =>
            (e.from.includes(s) || e.to.includes(s)) &&
            (e.to.includes(name) || e.from.includes(name)),
        ),
      ) ?? seeds[0]!;
    if (
      tableJobs.some(
        (j) => j.table_name === name && j.seed.toUpperCase() === seed.toUpperCase(),
      )
    ) {
      continue;
    }
    if (seenTables.has(name)) continue;
    seenTables.add(name);
    tableJobs.push({
      seed,
      field_name: parseFieldLikeSeeds([seed])[0]?.field_name ?? seed,
      table_name: name,
      relation_type: "GRAPH_TABLE_NEIGHBOR",
      field_is_key: false,
    });
  }

  // Prefer key-field tables, then collect profiles before rows globally.
  tableJobs.sort(
    (a, b) => Number(b.field_is_key) - Number(a.field_is_key),
  );

  indexes_used.push("symbol-index/config-table");
  let profilesKept = 0;

  for (const job of tableJobs) {
    if (hits.length >= CONFIG_TABLE_EXPANSION_BUDGETS.max_total_hits) break;

    links.push({
      table_name: job.table_name,
      field_name: job.field_name,
      relation_type: job.relation_type,
      field_is_key: job.field_is_key,
      seed: job.seed,
    });

    const symMap = lookupPortableSymbols(params.projectId, [job.table_name], params.dataRoot);
    const ids = [...symMap.values()].flat().slice(0, 40);
    const recs = lookupPortableSymbolRecords(
      params.projectId,
      ids,
      params.dataRoot,
    ).filter(isConfigInventorySymbol);
    const evidence = fetchPortableEvidenceByIds(
      params.projectId,
      recs.map((r) => r.document_id),
      params.dataRoot,
    );

    const candidateIds: string[] = [];
    let rowsForTable = 0;

    // Profiles first, then rows that mention the seed field.
    const ordered = [...recs].sort((a, b) => {
      const ap =
        String(a.knowledge_unit_type).toLowerCase() === "table_profile" ||
        String(a.object_type).toUpperCase() === "TABLE"
          ? 0
          : 1;
      const bp =
        String(b.knowledge_unit_type).toLowerCase() === "table_profile" ||
        String(b.object_type).toUpperCase() === "TABLE"
          ? 0
          : 1;
      return ap - bp;
    });

    for (const rec of ordered) {
      if (hits.length >= CONFIG_TABLE_EXPANSION_BUDGETS.max_total_hits) break;
      if (expansionSeen.has(rec.document_id)) continue;

      const kut = String(rec.knowledge_unit_type ?? "").toLowerCase();
      const ot = String(rec.object_type ?? "").toUpperCase();
      const isProfile =
        kut === "table_profile" || ot === "TABLE" || ot === "TABLE_PROFILE";
      const isRow = kut === "table_row" || ot === "TABLE_ROW";

      if (isProfile) {
        if (profilesKept >= CONFIG_TABLE_EXPANSION_BUDGETS.max_profiles) continue;
      } else if (isRow) {
        if (rowsForTable >= CONFIG_TABLE_EXPANSION_BUDGETS.max_rows_per_table) {
          continue;
        }
        if (!rowMentionsField(rec, job.field_name)) continue;
      } else {
        continue;
      }

      const doc = evidence.get(rec.document_id) ?? null;
      if (isRow && doc && !rowMentionsField(doc, job.field_name)) continue;

      expansionSeen.add(rec.document_id);
      candidateIds.push(rec.document_id);
      if (isProfile) profilesKept += 1;
      if (isRow) rowsForTable += 1;

      const meta = {
        config_table_expansion: true,
        expansion_seed: job.seed,
        expansion_relation: job.relation_type,
        expansion_table: job.table_name,
        expansion_field: job.field_name,
        // Caller can remarqu an existing Access hit when true.
        expansion_promote_existing: alreadySeen.has(rec.document_id),
      };
      hits.push(
        symbolToHit(
          rec,
          hits.length + 1,
          meta,
          [
            "config_table_expansion",
            `seed:${job.seed}`,
            `rel:${job.relation_type}`,
            `table:${job.table_name}`,
            `sym:${job.field_name}`,
          ],
          doc,
        ),
      );
    }

    if (candidateIds.length) {
      trace.push({
        seed: job.seed,
        relation_type: job.relation_type,
        table_name: job.table_name,
        candidate_ids: candidateIds,
      });
    }
  }

  if (hits.length > 0) {
    warnings.push(
      `Config/Table-Expansion (1-Hop): ${links.length} Links → ${hits.length} Candidates (TABLE_HAS_FIELD/Graph).`,
    );
  }

  return {
    hits,
    links,
    indexes_used: [...new Set(indexes_used)],
    warnings,
    trace,
  };
}

/**
 * Keep 1-hop config/table expansion hits in the synthesis pack even when
 * soft lexical ranking would otherwise drop them behind code units.
 */
export function mergePreserveConfigTableExpansion(
  primary: KnowledgeHit[],
  allHits: KnowledgeHit[],
): KnowledgeHit[] {
  const cfg = allHits.filter(isConfigTableExpansionHit);
  if (cfg.length === 0) return primary;
  // Prefer profiles, then rows; cap to budget.
  const profiles = cfg.filter(
    (h) =>
      String(h.knowledge_unit_type).toLowerCase() === "table_profile" ||
      String(h.object_type).toUpperCase() === "TABLE",
  );
  const rows = cfg.filter(
    (h) =>
      String(h.knowledge_unit_type).toLowerCase() === "table_row" ||
      String(h.object_type).toUpperCase() === "TABLE_ROW",
  );
  const keep = [
    ...profiles.slice(0, CONFIG_TABLE_EXPANSION_BUDGETS.max_profiles),
    ...rows.slice(0, CONFIG_TABLE_EXPANSION_BUDGETS.max_total_hits),
  ].slice(0, CONFIG_TABLE_EXPANSION_BUDGETS.max_total_hits);

  const seen = new Set<string>();
  const out: KnowledgeHit[] = [];
  // Keep existing primary order, but inject missing config hits after seed
  // enrichment blocks (ids starting with enrichment:) when present.
  let insertAt = 0;
  for (let i = 0; i < primary.length; i++) {
    const id = primary[i]!.search_document_id;
    if (String(id).startsWith("enrichment:")) insertAt = i + 1;
  }
  const head = primary.slice(0, insertAt);
  const tail = primary.slice(insertAt);
  for (const h of [...head, ...keep, ...tail]) {
    if (seen.has(h.search_document_id)) continue;
    seen.add(h.search_document_id);
    out.push(h);
  }
  return out.map((h, i) => ({ ...h, rank: i + 1 }));
}
