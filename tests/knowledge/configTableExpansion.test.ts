/**
 *   npx tsx tests/knowledge/configTableExpansion.test.ts
 */
import assert from "assert";
import { resolve } from "path";
import { loadEnvFile } from "../../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../../src/lib/localData/root";
import {
  expandConfigTablesFromSeeds,
  isConfigTableExpansionHit,
  loadFieldToTablesIndex,
} from "../../src/lib/knowledge/configTableExpansion";
import type { KnowledgeHit } from "../../src/lib/knowledge/types";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

function hit(id: string, meta: Record<string, unknown> = {}): KnowledgeHit {
  return {
    rank: 1,
    search_document_id: id,
    source_key: id,
    title: id,
    knowledge_unit_type: "table_row",
    combined_score: 10,
    exact_score: 3,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.8,
    matched_terms: ["config_table_expansion"],
    snippet: "ZZTVAG | ZZ_VLAGER=X",
    evidence_refs: [],
    facts: [],
    inferences: [],
    metadata: { config_table_expansion: true, ...meta },
    object_name: "ZZTVAG",
    object_type: "TABLE_ROW",
    subobject_name: "",
    technical_summary: "",
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: [],
    entities: [],
    relations: [],
    evidence: [],
    doc_confidence: 0.8,
  };
}

assert.ok(isConfigTableExpansionHit(hit("r1")));
assert.ok(
  !isConfigTableExpansionHit({
    ...hit("r2"),
    metadata: {},
    matched_terms: [],
  }),
);

const idx = loadFieldToTablesIndex("P01");
const vlag = idx.get("ZZ_VLAGER") ?? [];
assert.ok(
  vlag.some((t) => t.table_name === "ZZTVAG"),
  "ZZTVAG should declare ZZ_VLAGER",
);
assert.ok(
  vlag.some((t) => t.table_name === "ZVLAGER_AUART"),
  "ZVLAGER_AUART should declare ZZ_VLAGER",
);

const expanded = expandConfigTablesFromSeeds({
  projectId: "P01",
  confirmedSeeds: ["ZZ_VLAGER", "KNVV-ZZ_VLAGER"],
});
assert.ok(expanded.hits.length > 0, "expected config/table candidates");
assert.ok(
  expanded.hits.some(
    (h) => /ZZTVAG/i.test(h.title) || h.object_name === "ZZTVAG",
  ),
);
assert.ok(
  expanded.hits.some(
    (h) =>
      /ZVLAGER_AUART/i.test(h.title) || h.object_name === "ZVLAGER_AUART",
  ),
);
assert.ok(expanded.trace.some((t) => t.table_name === "ZZTVAG"));
assert.ok(expanded.hits.every((h) => isConfigTableExpansionHit(h)));

// Already-seen IDs must still be emitted (promote/remarqu), not skipped.
const seenIds = new Set(
  expanded.hits
    .filter((h) => h.object_name === "ZZTVAG" || /ZZTVAG/i.test(h.title))
    .map((h) => h.search_document_id)
    .slice(0, 2),
);
const promoted = expandConfigTablesFromSeeds({
  projectId: "P01",
  confirmedSeeds: ["ZZ_VLAGER"],
  alreadySeenIds: seenIds,
});
assert.ok(
  promoted.hits.some(
    (h) =>
      seenIds.has(h.search_document_id) &&
      h.metadata?.expansion_promote_existing === true,
  ),
  "already-seen ZZTVAG docs must be promoted with config flags",
);
assert.ok(
  promoted.hits.some(
    (h) =>
      /ZVLAGER_AUART/i.test(h.title) || h.object_name === "ZVLAGER_AUART",
  ),
  "ZVLAGER_AUART still expands when other tables are already seen",
);

console.log(
  JSON.stringify(
    {
      links: expanded.links.slice(0, 8),
      hit_n: expanded.hits.length,
      titles: expanded.hits.slice(0, 10).map((h) => h.title),
      trace: expanded.trace.slice(0, 8),
    },
    null,
    2,
  ),
);
console.log("configTableExpansion.test.ts: ok");
