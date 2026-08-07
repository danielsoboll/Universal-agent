import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessLocalExactCoverage,
  decideSearchBudgetAfterLocalExact,
  extractNamedExternalEntity,
  finalizeSearchBudgetAfterRetrieval,
  namedEntityTechnicalAnchors,
  prioritizeCommunicationHits,
} from "@/lib/knowledge/searchBudget";
import type { KnowledgeHit } from "@/lib/knowledge/types";

function hit(partial: Partial<KnowledgeHit> & { title: string }): KnowledgeHit {
  return {
    rank: 1,
    search_document_id: partial.search_document_id ?? "id1",
    source_key: partial.source_key ?? "sk1",
    title: partial.title,
    knowledge_unit_type: partial.knowledge_unit_type ?? "message_idoc_object",
    combined_score: partial.combined_score ?? 50,
    exact_score: partial.exact_score ?? 3,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.9,
    matched_terms: partial.matched_terms ?? ["sym:ZECD"],
    snippet: partial.snippet ?? "ZECD",
    evidence_refs: [],
    facts: partial.facts ?? ["output processing"],
    inferences: [],
    metadata: {},
    object_name: partial.object_name ?? "ZECD",
    object_type: partial.object_type ?? "output_processing",
    subobject_name: "",
    technical_summary: partial.technical_summary ?? "TNAPR ZECD",
    business_purpose: "",
    tables_read: ["TNAPR"],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: [],
    entities: [],
    relations: [],
    evidence: [],
    doc_confidence: 0.9,
    ...partial,
  } as KnowledgeHit;
}

describe("extractNamedExternalEntity", () => {
  it("extracts technical symbol from ZECD question", () => {
    const e = extractNamedExternalEntity(
      "Was wissen wir über die Nachricht ZECD?",
    );
    assert.ok(e);
    assert.match(e!.raw.toUpperCase(), /ZECD/);
  });

  it("extracts bare EDIOCTOPUS", () => {
    const e = extractNamedExternalEntity("EDIOCTOPUS");
    assert.equal(e?.raw.toUpperCase(), "EDIOCTOPUS");
  });

  it("builds anchors for Edeka-style cue", () => {
    const anchors = namedEntityTechnicalAnchors(
      "Wie funktioniert das Edeka virtuelle Lager?",
    );
    assert.ok(anchors.some((a) => /EDEKA/i.test(a)));
  });
});

describe("LOCAL_EXACT coverage", () => {
  it("marks ZECD communication hit as sufficient without Stage 2", () => {
    const hits = [
      hit({
        title: "output_processing: ZECD",
        object_type: "output_processing",
        object_name: "V1|ZECD|8",
      }),
    ];
    const cov = assessLocalExactCoverage({
      hits,
      anchors: ["ZECD"],
      namedEntity: "ZECD",
    });
    assert.equal(cov.sufficient, true);
    assert.ok(cov.communication_hits.length >= 1);
    assert.equal(cov.missing_code_analysis.length, 0);
  });

  it("gate stays LOCAL_EXACT for ZECD — no on-demand analysis", () => {
    const hits = [
      hit({
        title: "output_type: ZECD",
        object_type: "output_type",
        knowledge_unit_type: "message_idoc_object",
      }),
    ];
    const d0 = decideSearchBudgetAfterLocalExact({
      question: "Was wissen wir über die Nachricht ZECD?",
      searchMode: "direct_rag",
      localHits: hits,
    });
    assert.equal(d0.stage, "LOCAL_EXACT");
    assert.equal(d0.allow_on_demand_analysis, false);
    assert.equal(d0.allow_vector_retrieval, false);

    const fin = finalizeSearchBudgetAfterRetrieval({
      question: "Was wissen wir über die Nachricht ZECD?",
      searchMode: "direct_rag",
      prior: d0,
      retrievalHits: hits,
      relevanceSufficient: true,
    });
    assert.equal(fin.stage, "LOCAL_EXACT");
    assert.equal(fin.diagnostics.on_demand_executed, 0);
    assert.ok(
      fin.diagnostics.blocked_reason?.includes("On-Demand") ||
        fin.diagnostics.blocked_reason?.includes("Canonical"),
    );
  });

  it("prioritizes partner_profile over weak noise", () => {
    const ranked = prioritizeCommunicationHits(
      [
        hit({
          title: "noise table",
          knowledge_unit_type: "control_table",
          object_type: "table",
          exact_score: 1,
          combined_score: 90,
          search_document_id: "n1",
        }),
        hit({
          title: "partner_profile: EDIOCTOPUS",
          object_type: "partner_profile",
          knowledge_unit_type: "message_idoc_object",
          exact_score: 3,
          combined_score: 40,
          search_document_id: "p1",
          matched_terms: ["sym:EDIOCTOPUS"],
          object_name: "LS|EDIOCTOPUS",
        }),
      ],
      ["EDIOCTOPUS"],
    );
    assert.match(ranked[0]!.title, /partner_profile/i);
  });

  it("fail-closes when named anchor has zero exact hits after retrieval", () => {
    const d0 = decideSearchBudgetAfterLocalExact({
      question: "EDIOCTOPUS",
      searchMode: "direct_rag",
      localHits: [],
    });
    assert.equal(d0.stage, "EXISTING_RETRIEVAL");
    const fin = finalizeSearchBudgetAfterRetrieval({
      question: "EDIOCTOPUS",
      searchMode: "direct_rag",
      prior: d0,
      retrievalHits: [
        hit({
          title: "unrelated",
          object_name: "OTHER",
          object_type: "table",
          knowledge_unit_type: "control_table",
          exact_score: 0,
          matched_terms: [],
          snippet: "something else",
          search_document_id: "x",
        }),
      ],
      relevanceSufficient: false,
    });
    assert.equal(fin.fail_closed, true);
    assert.match(fin.fail_closed_message ?? "", /EDIOCTOPUS/);
  });
});
