/**
 * Load deterministic cross-source facts for confirmed FIELD-like seeds.
 * Uses existing entity JSONL + portable graph/code-usage indexes only.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  lookupPortableCodeUsage,
  lookupPortableGraphNeighbors,
  lookupPortableSymbols,
} from "@/lib/portableIndex/indexLoader";
import type {
  CodeUsageSample,
  ConfigNeighborSample,
  FieldSeedEnrichment,
  FieldSeedRef,
  FieldValueObservation,
  MasterDataInstanceSample,
  SeedEnrichmentPack,
} from "@/lib/knowledge/seedEnrichment/types";

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function readJsonlObjects(abs: string): Record<string, unknown>[] {
  if (!existsSync(abs)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip
    }
  }
  return out;
}

function topCounts(map: Map<string, number>, n = 8): FieldValueObservation[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

/** FIELD-like seeds: TABLE-FIELD or ZZ_* (generic custom field pattern). */
export function parseFieldLikeSeeds(seeds: string[]): FieldSeedRef[] {
  const out: FieldSeedRef[] = [];
  const seen = new Set<string>();
  for (const raw of seeds) {
    const seed = raw.trim().toUpperCase();
    if (!seed || seen.has(seed)) continue;
    let table_name: string | null = null;
    let field_name = seed;
    if (seed.includes("-")) {
      const [t, f] = seed.split("-", 2);
      if (t && f) {
        table_name = t;
        field_name = f;
      }
    } else if (!/^ZZ_[A-Z0-9_]+$/.test(seed) && !/^[A-Z][A-Z0-9_]{2,30}$/.test(seed)) {
      // skip soft lexical tokens
      continue;
    } else if (!/^ZZ_/i.test(seed) && !seed.includes("-")) {
      // bare technical names that are not ZZ_ may be classes/programs — only keep if hyphen form or ZZ_
      continue;
    }
    // Accept ZZ_* always; accept TABLE-FIELD always
    if (!seed.includes("-") && !/^ZZ_/i.test(seed)) continue;
    seen.add(seed);
    out.push({ seed, table_name, field_name });
  }
  return out;
}

function resolveProjectPaths(projectId: string, dataRoot?: string) {
  const root = dataRoot ?? getLocalDataRoot();
  const cust = path.join(
    root,
    projectId,
    "canonical",
    "master-data",
    "customers",
  );
  return {
    root,
    fields: path.join(cust, "entities", "fields.jsonl"),
    attrs: path.join(cust, "entities", "attributes.jsonl"),
    sales: path.join(cust, "entities", "sales_areas.jsonl"),
    customers: path.join(cust, "entities", "customers.jsonl"),
    links: path.join(cust, "links", "cross_source_links.jsonl"),
  };
}

function enrichOneField(params: {
  projectId: string;
  systemId: string;
  seed: FieldSeedRef;
  paths: ReturnType<typeof resolveProjectPaths>;
  sampleLimit: number;
}): FieldSeedEnrichment {
  const { projectId, systemId, seed, paths, sampleLimit } = params;
  const evidence_paths: string[] = [];

  // --- DDIC / FIELD entity ---
  const fieldRows = readJsonlObjects(paths.fields);
  const fieldMatch =
    fieldRows.find((r) => {
      const fname = asString(r.field_name).toUpperCase();
      const tname = asString(r.table_name).toUpperCase();
      if (fname !== seed.field_name) return false;
      if (seed.table_name && tname && tname !== seed.table_name) return false;
      return true;
    }) ?? null;

  const ddic = fieldMatch
    ? {
        table_name: asString(fieldMatch.table_name) || seed.table_name,
        field_name: asString(fieldMatch.field_name) || seed.field_name,
        description: asString(fieldMatch.description) || null,
        data_element: asString(fieldMatch.data_element) || null,
        domain: asString(fieldMatch.domain) || null,
        entity_id: asString(fieldMatch.entity_id) || null,
        source_key: asString(fieldMatch.source_key) || null,
      }
    : {
        table_name: seed.table_name,
        field_name: seed.field_name,
        description: null,
        data_element: null,
        domain: null,
        entity_id: `FIELD|${systemId}|${seed.table_name || "?"}|${seed.field_name}`,
        source_key: seed.table_name
          ? `${seed.table_name}-${seed.field_name}`
          : seed.field_name,
      };
  if (fieldMatch) evidence_paths.push("canonical/master-data/customers/entities/fields.jsonl");

  // --- Master-data attribute instances ---
  const attrs = readJsonlObjects(paths.attrs).filter((r) => {
    const fname = asString(r.field_name).toUpperCase();
    if (fname !== seed.field_name) return false;
    if (seed.table_name) {
      const tname = asString(r.table_name).toUpperCase();
      if (tname && tname !== seed.table_name) return false;
    }
    return true;
  });

  const valueDist = new Map<string, number>();
  const owners = new Set<string>();
  const customers = new Set<string>();
  const vkorgDist = new Map<string, number>();
  const vtwegDist = new Map<string, number>();
  const spartDist = new Map<string, number>();

  const salesById = new Map<string, Record<string, unknown>>();
  const custById = new Map<string, Record<string, unknown>>();
  if (attrs.length > 0) {
    for (const s of readJsonlObjects(paths.sales)) {
      salesById.set(asString(s.entity_id), s);
    }
    for (const c of readJsonlObjects(paths.customers)) {
      custById.set(asString(c.entity_id), c);
    }
    evidence_paths.push(
      "canonical/master-data/customers/entities/attributes.jsonl",
      "canonical/master-data/customers/entities/sales_areas.jsonl",
      "canonical/master-data/customers/entities/customers.jsonl",
    );
  }

  const samples: MasterDataInstanceSample[] = [];
  for (const a of attrs) {
    const value = asString(a.value) || asString(a.normalized_value);
    if (value) valueDist.set(value, (valueDist.get(value) ?? 0) + 1);
    const owner = asString(a.owner_entity_id);
    if (owner) owners.add(owner);
    const sa = salesById.get(owner);
    const kunnr = sa ? asString(sa.kunnr) : null;
    if (kunnr) customers.add(kunnr);
    const vkorg = sa ? asString(sa.vkorg) : null;
    const vtweg = sa ? asString(sa.vtweg) : null;
    const spart = sa ? asString(sa.spart) : null;
    if (vkorg) vkorgDist.set(vkorg, (vkorgDist.get(vkorg) ?? 0) + 1);
    if (vtweg) vtwegDist.set(vtweg, (vtwegDist.get(vtweg) ?? 0) + 1);
    if (spart) spartDist.set(spart, (spartDist.get(spart) ?? 0) + 1);
    if (samples.length < sampleLimit) {
      const custId = sa ? asString(sa.customer_entity_id) : "";
      const cust = custById.get(custId);
      samples.push({
        owner_entity_id: owner,
        kunnr,
        name1: cust ? asString(cust.name1) || null : null,
        name2: cust ? asString(cust.name2) || null : null,
        vkorg,
        vtweg,
        spart,
        value,
        source_key: asString(a.source_key),
        relative_source_path: asString(a.relative_source_path),
      });
    }
  }

  // --- Code usage from entity links + portable code_usage ---
  const codeSamples: CodeUsageSample[] = [];
  const byRelation: Record<string, number> = {};
  const fieldEntityId =
    ddic.entity_id ||
    `FIELD|${systemId}|${seed.table_name || "KNVV"}|${seed.field_name}`;
  const fieldTokens = seed.field_name
    .replace(/^ZZ_/i, "")
    .split(/_/)
    .map((t) => t.toUpperCase())
    .filter((t) => t.length >= 3);
  const linkRows = readJsonlObjects(paths.links);
  const codeRaw: CodeUsageSample[] = [];
  for (const l of linkRows) {
    const to = asString(l.to_entity_id);
    const rel = asString(l.link_type);
    if (!to.includes(`|${seed.field_name}`) && to !== fieldEntityId) continue;
    if (
      !["CHECKS_FIELD", "READS_FIELD", "REFERENCES_FIELD", "WRITES_FIELD"].includes(
        rel,
      )
    ) {
      continue;
    }
    byRelation[rel] = (byRelation[rel] ?? 0) + 1;
    const meta = (l.metadata as Record<string, unknown>) ?? {};
    codeRaw.push({
      relation: rel,
      object_name: asString(meta.object_name),
      subobject_name: asString(meta.subobject_name),
      source_key: asString(l.source_key),
      relative_source_path: asString(l.relative_source_path),
    });
  }
  codeRaw.sort((a, b) => {
    const score = (c: CodeUsageSample) => {
      let s = 0;
      const blob = `${c.object_name} ${c.subobject_name}`.toUpperCase();
      for (const t of fieldTokens) if (blob.includes(t)) s += 20;
      if (c.relation === "CHECKS_FIELD") s += 5;
      if (c.relation === "READS_FIELD") s += 2;
      return s;
    };
    return score(b) - score(a);
  });
  for (const c of codeRaw.slice(0, sampleLimit)) codeSamples.push(c);
  if (codeSamples.length) {
    evidence_paths.push(
      "canonical/master-data/customers/links/cross_source_links.jsonl",
    );
  }

  // Portable code usage postings (additional)
  const tokens = [
    seed.field_name,
    seed.table_name ? `${seed.table_name}-${seed.field_name}` : "",
  ].filter(Boolean);
  lookupPortableCodeUsage(projectId, tokens);

  // --- Graph / config neighbors ---
  const seedNames = [
    seed.seed,
    seed.field_name,
    seed.table_name ? `${seed.table_name}-${seed.field_name}` : "",
  ].filter(Boolean);
  const g = lookupPortableGraphNeighbors({
    projectId,
    seedNames,
    maxNeighborsPerSeed: 25,
  });
  const config_neighbors: ConfigNeighborSample[] = [];
  const graph_neighbor_names: string[] = [];
  for (const n of [...g.seed_nodes, ...g.neighbor_nodes]) {
    const name = asString(n.object_name);
    if (name) graph_neighbor_names.push(name);
  }
  for (const e of g.edges) {
    const toName =
      g.neighbor_nodes.find((n) => n.node_id === e.to)?.object_name ||
      g.seed_nodes.find((n) => n.node_id === e.to)?.object_name ||
      "";
    const fromName =
      g.seed_nodes.find((n) => n.node_id === e.from)?.object_name ||
      g.neighbor_nodes.find((n) => n.node_id === e.from)?.object_name ||
      "";
    for (const [nodeId, objName, objType] of [
      [
        e.to,
        toName,
        g.neighbor_nodes.find((n) => n.node_id === e.to)?.object_type || "",
      ],
      [
        e.from,
        fromName,
        g.seed_nodes.find((n) => n.node_id === e.from)?.object_type || "",
      ],
    ] as Array<[string, string, string]>) {
      const on = asString(objName);
      if (!on) continue;
      // Config-like: Z* tables / control objects — only if already in graph
      if (/^Z[A-Z0-9_]+$/i.test(on) && on.toUpperCase() !== seed.field_name) {
        if (
          config_neighbors.some(
            (c) => c.object_name === on && c.relation_type === e.relation_type,
          )
        ) {
          continue;
        }
        if (config_neighbors.length < sampleLimit) {
          config_neighbors.push({
            object_name: on,
            object_type: asString(objType) || "OBJECT",
            relation_type: asString(e.relation_type),
            node_id: nodeId,
          });
        }
      }
    }
  }

  // Also surface symbol hits for TABLE-FIELD itself
  lookupPortableSymbols(projectId, seedNames);

  return {
    seed,
    ddic,
    observed_values: topCounts(valueDist),
    master_instances: {
      total_attributes: attrs.length,
      distinct_owners: owners.size,
      distinct_customers: customers.size,
      vkorg_dist: topCounts(vkorgDist),
      vtweg_dist: topCounts(vtwegDist),
      spart_dist: topCounts(spartDist),
      samples,
    },
    code_usage: {
      total: Object.values(byRelation).reduce((s, n) => s + n, 0),
      by_relation: byRelation,
      samples: codeSamples,
    },
    config_neighbors,
    graph_neighbor_names: [...new Set(graph_neighbor_names)].slice(0, 40),
    evidence_paths: [...new Set(evidence_paths)],
  };
}

export function enrichConfirmedFieldSeeds(params: {
  projectId: string;
  systemId?: string;
  confirmedSeeds: string[];
  dataRoot?: string;
  sampleLimit?: number;
}): SeedEnrichmentPack {
  const sampleLimit = params.sampleLimit ?? 6;
  const systemId = params.systemId?.trim() || "D01";
  const fieldSeeds = parseFieldLikeSeeds(params.confirmedSeeds);
  // Dedupe by table|field so ZZ_VLAGER and KNVV-ZZ_VLAGER don't double-count
  const deduped: FieldSeedRef[] = [];
  const seenKey = new Set<string>();
  for (const s of fieldSeeds) {
    const k = `${s.table_name ?? "*"}|${s.field_name}`;
    if (seenKey.has(k)) continue;
    // Prefer TABLE-FIELD over bare ZZ_
    const bare = `*|${s.field_name}`;
    if (s.table_name && seenKey.has(bare)) {
      const idx = deduped.findIndex(
        (d) => !d.table_name && d.field_name === s.field_name,
      );
      if (idx >= 0) deduped.splice(idx, 1);
      seenKey.delete(bare);
    }
    if (!s.table_name && [...seenKey].some((x) => x.endsWith(`|${s.field_name}`) && !x.startsWith("*|"))) {
      continue;
    }
    seenKey.add(k);
    deduped.push(s);
  }
  const notes: string[] = [];

  if (deduped.length === 0) {
    return {
      enriched: false,
      field_enrichments: [],
      confirmed_seeds: params.confirmedSeeds,
      notes: ["Kein FIELD-ähnlicher bestätigter Seed für Enrichment."],
    };
  }

  const paths = resolveProjectPaths(params.projectId, params.dataRoot);
  const field_enrichments: FieldSeedEnrichment[] = [];

  for (const seed of deduped) {
    const one = enrichOneField({
      projectId: params.projectId,
      systemId,
      seed,
      paths,
      sampleLimit,
    });
    field_enrichments.push(one);
    notes.push(
      `FIELD ${seed.seed}: values=${one.observed_values.length}, instances=${one.master_instances.total_attributes}, code_links=${one.code_usage.total}, config=${one.config_neighbors.length}`,
    );
  }

  return {
    enriched: field_enrichments.some(
      (e) =>
        e.master_instances.total_attributes > 0 ||
        e.code_usage.total > 0 ||
        e.config_neighbors.length > 0 ||
        e.ddic?.description,
    ),
    field_enrichments: field_enrichments
      .filter(
        (e) =>
          e.master_instances.total_attributes > 0 ||
          e.code_usage.total > 0 ||
          Boolean(e.ddic?.description && e.observed_values.length > 0),
      )
      .sort((a, b) => {
        const score = (e: FieldSeedEnrichment) =>
          e.master_instances.total_attributes * 10 +
          e.code_usage.total * 5 +
          e.config_neighbors.length;
        return score(b) - score(a);
      })
      .slice(0, 2),
    confirmed_seeds: params.confirmedSeeds,
    notes,
  };
}
