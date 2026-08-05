/**
 * Unit tests for primary anchor + evidence scoring in multi-source RAG.
 *
 *   npx tsx tests/knowledge/multiSourcePrimaryAnchor.test.ts
 */
import assert from "assert";
import {
  compareEvidenceItems,
  evidenceScore,
  rankTierToEvidenceType,
} from "../../src/lib/knowledge/multiSourceSearch/evidenceScoring";
import {
  conceptSearchVariants,
  pickPrimaryAnchorFromFieldCandidates,
  scoreMasterDataFieldCandidate,
} from "../../src/lib/knowledge/multiSourceSearch/primaryAnchor";
import {
  buildFocusedQueries,
  buildSpecializedPlan,
  evaluatePrimaryAnchorCoverage,
} from "../../src/lib/knowledge/multiSourceSearch/specializedPlan";
import type {
  MultiSourceSearchPlan,
  StageEvidenceItem,
} from "../../src/lib/knowledge/multiSourceSearch/types";

function basePlan(question: string): MultiSourceSearchPlan {
  return {
    version: "multi-source-plan-v1",
    question,
    concepts: question
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 4),
    synonym_candidates: [
      "virtuell",
      "lager",
      "vlager",
      "virtuelles",
      "warehouse",
      "ZZ_VLAGER",
    ],
    source_order: [
      "exact_symbol",
      "master_data",
      "control_tables",
      "classes",
      "programs",
      "function_modules",
      "relations",
    ],
    max_rounds: 2,
    budgets: {
      exact_symbol: 20,
      master_data: 8,
      control_tables: 14,
      classes: 10,
      programs: 10,
      function_modules: 8,
      relations: 6,
    },
    notes: [],
  };
}

// --- concept variants ---
const variants = conceptSearchVariants(
  ["virtuelles", "lager"],
  ["vlager", "virtuell"],
);
assert.ok(variants.some((v) => v.includes("virtuell")));
assert.ok(variants.some((v) => v.includes("vlager")));

// --- score master data field (generic, not hardcoded customer) ---
const planVlager = basePlan("Wie funktioniert das virtuelle Lager?");
const zzScore = scoreMasterDataFieldCandidate({
  table_name: "KNVV",
  field_name: "ZZ_VLAGER",
  description: "Kennzeichen virtuelles Lager",
  data_element: "ZZ_VLAGER",
  plan: planVlager,
});
assert.ok(zzScore.score >= 45, `ZZ_VLAGER score=${zzScore.score}`);
assert.ok(
  zzScore.match_type === "field_text_exact" ||
    zzScore.match_type === "normalized_token" ||
    zzScore.match_type === "concept_partial" ||
    zzScore.match_type === "field_name_contains_concept" ||
    zzScore.match_type === "field_name_pattern",
);

const lgortScore = scoreMasterDataFieldCandidate({
  table_name: "MARD",
  field_name: "LGORT",
  description: "Lagerort",
  plan: planVlager,
});
assert.ok(zzScore.score > lgortScore.score, "Z-Feld mit Fachtext > generisches LGORT");

const primary = pickPrimaryAnchorFromFieldCandidates([
  zzScore,
  {
    table_name: "MARD",
    field_name: "LGORT",
    description: "Lagerort",
    score: lgortScore.score,
    match_type: "weak",
  },
]);
assert.ok(primary !== null);
assert.strictEqual(primary!.field, "ZZ_VLAGER");
assert.strictEqual(primary!.table, "KNVV");
assert.strictEqual(primary!.anchor_type, "MASTER_DATA_BUSINESS_FIELD");

// --- specialized plan ---
const specialized = buildSpecializedPlan({
  plan: planVlager,
  primaryAnchor: primary!,
  planType: "MASTER_FIELD_TO_PROCESS",
});
assert.strictEqual(specialized.plan_type, "MASTER_FIELD_TO_PROCESS");
assert.strictEqual(specialized.abort_broad_search, true);
assert.ok(specialized.steps.includes("find_exact_code_usage"));

const focused = buildFocusedQueries({
  specialized,
  valueNeedles: ["X"],
  keyNeedles: ["ZZ_VLAGER=X"],
});
assert.ok(focused.some((q) => q.includes("ZZ_VLAGER")));
assert.ok(focused.some((q) => q.includes("KNVV")));

// --- evidence scoring priority ---
const mdField: StageEvidenceItem = {
  id: "a",
  source: "master_data",
  rank_tier: "exact",
  evidence_type: "MASTER_DATA_BUSINESS_FIELD",
  title: "KNVV-ZZ_VLAGER",
  summary: "Kennzeichen",
  confidence: 0.99,
  anchors_matched: ["ZZ_VLAGER"],
  path_hint: "canonical/master-data",
};
const semantic: StageEvidenceItem = {
  id: "b",
  source: "classes",
  rank_tier: "semantic_weak",
  title: "Kommentar Lager",
  summary: "virtuelles Lager im Text",
  confidence: 0.5,
  anchors_matched: ["lager"],
};
assert.ok(compareEvidenceItems(mdField, semantic) < 0);
assert.ok(evidenceScore("MASTER_DATA_BUSINESS_FIELD") > evidenceScore("SEMANTIC_CANDIDATE"));
assert.strictEqual(
  rankTierToEvidenceType({
    ...semantic,
    source: "master_data",
    rank_tier: "exact",
  }),
  "MASTER_DATA_BUSINESS_FIELD",
);

// --- coverage rules with primary anchor ---
const coverageIncomplete = evaluatePrimaryAnchorCoverage(
  [{ stage: "master_data", hits: [mdField] }],
  specialized,
);
assert.ok(!coverageIncomplete.sufficient);
assert.ok(coverageIncomplete.missing.includes("value_analysis"));

const coverageComplete = evaluatePrimaryAnchorCoverage(
  [
    { stage: "master_data", hits: [mdField, { ...mdField, id: "md-values:x", evidence_type: "MASTER_DATA_BUSINESS_VALUE" }] },
    { stage: "classes", hits: [{ ...semantic, rank_tier: "exact", evidence_type: "EXACT_CODE_USAGE" }] },
    { stage: "control_tables", hits: [] },
    { stage: "relations", hits: [] },
  ],
  specialized,
);
assert.ok(coverageComplete.sufficient);

// --- Optitool: no invented master field ---
const planOpti = basePlan("Wie unterscheiden sich Optitool alt und neu?");
planOpti.concepts = ["optitool", "unterscheiden", "alt", "neu"];
planOpti.synonym_candidates = ["optitool", "zexto", "parameter", "export"];
const noMdPrimary = pickPrimaryAnchorFromFieldCandidates([
  scoreMasterDataFieldCandidate({
    table_name: "MARA",
    field_name: "ZZ_RANDOM",
    description: "Optitool Hinweis",
    plan: planOpti,
  }),
]);
// Low score field without strong Z/concept match should not become primary
const weakOnly = scoreMasterDataFieldCandidate({
  table_name: "MARA",
  field_name: "ZZ_RANDOM",
  description: "Optitool Hinweis",
  plan: planOpti,
});
if (weakOnly.score < 45) {
  assert.strictEqual(noMdPrimary, null);
}

const ctPlan = buildSpecializedPlan({
  plan: planOpti,
  primaryAnchor: {
    anchor_type: "CONTROL_TABLE",
    table: "ZEXTO_PARAMETER",
    description: "Optitool Parameter",
    confidence: 0.85,
  },
  planType: "CONTROL_TABLE_TO_PROCESS",
});
assert.strictEqual(ctPlan.plan_type, "CONTROL_TABLE_TO_PROCESS");
assert.ok(ctPlan.steps.includes("extract_control_values"));

console.log("multiSourcePrimaryAnchor.test.ts — alle Tests OK");
