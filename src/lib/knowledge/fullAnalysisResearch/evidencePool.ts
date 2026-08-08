/**
 * Evidence pool + delta measurement between Vollanalyse iterations.
 */
import type { KnowledgeHit } from "@/lib/knowledge/knowledgeRetriever";
import type {
  EvidenceDelta,
  ResearchPoolSnapshot,
} from "@/lib/knowledge/fullAnalysisResearch/types";

export function emptyPoolSnapshot(): ResearchPoolSnapshot {
  return {
    evidence_keys: new Set(),
    analysis_keys: new Set(),
    relation_keys: new Set(),
    node_keys: new Set(),
    known_claims: new Set(),
  };
}

export function snapshotFromHits(
  hits: KnowledgeHit[],
  extras?: {
    analysisKeys?: string[];
    knownClaims?: string[];
  },
): ResearchPoolSnapshot {
  const snap = emptyPoolSnapshot();
  for (const h of hits) {
    const key = String(h.source_key || "").trim();
    if (key) snap.evidence_keys.add(key);
    const kut = String(h.knowledge_unit_type ?? "").toLowerCase();
    if (kut.includes("analysis")) snap.analysis_keys.add(key);
    if (kut.includes("relation") || kut === "edge") snap.relation_keys.add(key);
    if (kut.includes("node") || kut === "object") snap.node_keys.add(key);
    for (const t of h.tables_read ?? []) {
      if (t) snap.node_keys.add(`TABLE:${String(t).toUpperCase()}`);
    }
    for (const t of h.tables_written ?? []) {
      if (t) snap.node_keys.add(`TABLE:${String(t).toUpperCase()}`);
    }
    for (const m of h.called_methods ?? []) {
      if (m) snap.relation_keys.add(`CALLS:${String(m).toUpperCase()}`);
    }
  }
  for (const k of extras?.analysisKeys ?? []) snap.analysis_keys.add(k);
  for (const c of extras?.knownClaims ?? []) {
    const t = c.trim();
    if (t) snap.known_claims.add(t);
  }
  return snap;
}

export function mergeHits(
  existing: KnowledgeHit[],
  incoming: KnowledgeHit[],
): KnowledgeHit[] {
  const byKey = new Map<string, KnowledgeHit>();
  for (const h of existing) {
    const k = String(h.source_key || "").trim();
    if (k) byKey.set(k, h);
  }
  for (const h of incoming) {
    const k = String(h.source_key || "").trim();
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev || (h.combined_score ?? 0) > (prev.combined_score ?? 0)) {
      byKey.set(k, h);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => (b.combined_score ?? 0) - (a.combined_score ?? 0),
  );
}

export function measureEvidenceDelta(
  before: ResearchPoolSnapshot,
  after: ResearchPoolSnapshot,
): EvidenceDelta {
  const countNew = (a: Set<string>, b: Set<string>) => {
    let n = 0;
    for (const x of b) if (!a.has(x)) n += 1;
    return n;
  };
  const new_evidence_docs = countNew(before.evidence_keys, after.evidence_keys);
  const new_method_analyses = countNew(before.analysis_keys, after.analysis_keys);
  const new_relations = countNew(before.relation_keys, after.relation_keys);
  const new_nodes = countNew(before.node_keys, after.node_keys);
  const new_confirmed_claims = countNew(before.known_claims, after.known_claims);
  const has_knowledge_gain =
    new_evidence_docs > 0 ||
    new_method_analyses > 0 ||
    new_relations > 0 ||
    new_nodes > 0 ||
    new_confirmed_claims > 0;
  return {
    new_evidence_docs,
    new_method_analyses,
    new_relations,
    new_nodes,
    new_confirmed_claims,
    has_knowledge_gain,
  };
}

/** Compact evidence digest for the planner (not the final answer). */
export function summarizeEvidenceForPlanner(
  hits: KnowledgeHit[],
  limit = 28,
): string {
  const lines: string[] = [];
  for (const h of hits.slice(0, limit)) {
    const title = h.title || h.source_key;
    const kut = h.knowledge_unit_type || "?";
    const facts = (h.facts ?? []).slice(0, 3).join("; ");
    const tables = [...(h.tables_read ?? []), ...(h.tables_written ?? [])]
      .slice(0, 6)
      .join(",");
    const methods = (h.called_methods ?? []).slice(0, 6).join(",");
    lines.push(
      `- [${kut}] ${title} | tables=${tables || "—"} | calls=${methods || "—"} | facts=${facts || "—"}`,
    );
  }
  if (hits.length > limit) {
    lines.push(`… +${hits.length - limit} weitere Evidence-Docs`);
  }
  return lines.join("\n");
}
