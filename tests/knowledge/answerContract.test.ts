/**
 *   npx tsx tests/knowledge/answerContract.test.ts
 */
import assert from "assert";
import {
  buildAnswerContract,
  ANSWER_CONTRACT_NO_PROCESS_MSG,
} from "../../src/lib/knowledge/answerContract";
import { classifyQuestionIntent } from "../../src/lib/knowledge/questionIntent";
import { buildEvidenceContext } from "../../src/lib/knowledge/evidenceContext";
import type { KnowledgeHit } from "../../src/lib/knowledge/knowledgeRetriever";
import type { LlmAnswerPayload } from "../../src/lib/knowledge/answerSchema";

function hit(partial: Partial<KnowledgeHit> & { rank: number }): KnowledgeHit {
  return {
    search_document_id: partial.search_document_id ?? `id-${partial.rank}`,
    source_key: partial.source_key ?? `KEY_${partial.rank}`,
    title: partial.title ?? `Title ${partial.rank}`,
    knowledge_unit_type: partial.knowledge_unit_type ?? "code_unit",
    combined_score: partial.combined_score ?? 10,
    exact_score: 1,
    fulltext_score: 1,
    vector_score: 1,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 0.8,
    matched_terms: [],
    snippet: partial.snippet ?? "snippet",
    evidence_refs: [],
    facts: partial.facts ?? [],
    inferences: partial.inferences ?? [],
    metadata: {},
    object_name: partial.object_name ?? "ZCL_X",
    object_type: partial.object_type ?? "CLASS",
    subobject_name: partial.subobject_name ?? "METH",
    technical_summary: partial.technical_summary ?? "",
    business_purpose: partial.business_purpose ?? "",
    tables_read: partial.tables_read ?? [],
    tables_written: partial.tables_written ?? [],
    called_methods: partial.called_methods ?? [],
    called_functions: [],
    hardcoded_values: partial.hardcoded_values ?? [],
    entities: [],
    relations: partial.relations ?? [],
    evidence: partial.evidence ?? [],
    doc_confidence: 0.8,
    rank: partial.rank,
  };
}

function testIntentComparison() {
  const r = classifyQuestionIntent(
    "Wo wird zwischen Optitool alt und neu unterschieden?",
  );
  assert.equal(r.intent, "comparison");
  assert.equal(r.preferences.require_both_comparison_sides, true);
  console.log("ok intent comparison");
}

function testDemoteOverclaim() {
  const hits = [
    hit({
      rank: 1,
      source_key: "D01|CLASS|ZCL|METHOD|SET_KONZERNFARBE",
      subobject_name: "SET_KONZERNFARBE",
      facts: ["SET_KONZERNFARBE setzt R_KONZERNFARBE auf 08 bei RG-Partnern"],
      hardcoded_values: ["'08'", "'RG'", "'0000090080'"],
    }),
  ];
  const llm: LlmAnswerPayload = {
    process_answer: {
      summary: "Konzernfarbe 08 wird gesetzt.",
      has_safe_process_claim: true,
      open_items: [],
      statements: [
        {
          text: "SET_KONZERNFARBE setzt Konzernfarbe 08 bei Partnerrolle RG.",
          level: "confirmed",
          source_ranks: [1],
        },
        {
          text: "Dies dient der Segmentierung zur internen Steuerung der Kundenarchitektur.",
          level: "confirmed",
          source_ranks: [1],
        },
      ],
    },
    technical_answer: {
      entry_point: [],
      trigger: [],
      processing: [],
      objects: [],
      results: [],
      relations: [],
      open: [],
    },
    technical_details: {
      conditions: [],
      changed_fields: [],
      additional_evidence_notes: [],
    },
    source_ranks_used: [1],
    insufficient_evidence: false,
  };
  const intent = classifyQuestionIntent("Was macht SET_KONZERNFARBE?");
  const built = buildAnswerContract({ llm, hits, intent });
  assert.ok(built.process_answer.confirmed.length >= 1);
  assert.ok(
    built.process_answer.confirmed.every(
      (s) => !/Segmentierung|Kundenarchitektur/i.test(s.text),
    ),
    "overclaim must not stay confirmed",
  );
  assert.ok(
    built.process_answer.inferred.some((s) =>
      /Segmentierung|Kundenarchitektur|Abgeleitet/i.test(s.text),
    ),
    "overclaim should be inferred",
  );
  console.log("ok demote business overclaim");
}

function testStripUnverifiableConfirmed() {
  const hits = [hit({ rank: 1, facts: ["nur foo"] })];
  const llm: LlmAnswerPayload = {
    process_answer: {
      summary: "",
      has_safe_process_claim: true,
      open_items: [],
      statements: [
        {
          text: "Vollständig undokumentierte Magie steuert alle Bestellungen weltweit.",
          level: "confirmed",
          source_ranks: [],
        },
      ],
    },
    technical_answer: {
      entry_point: [],
      trigger: [],
      processing: [],
      objects: [],
      results: [],
      relations: [],
      open: [],
    },
    technical_details: {
      conditions: [],
      changed_fields: [],
      additional_evidence_notes: [],
    },
    source_ranks_used: [],
    insufficient_evidence: false,
  };
  const intent = classifyQuestionIntent("Was passiert?");
  const built = buildAnswerContract({ llm, hits, intent });
  assert.equal(built.process_answer.confirmed.length, 0);
  assert.equal(built.process_answer.has_safe_process_claim, false);
  assert.ok(
    built.process_answer.no_process_claim_message.includes("nicht dokumentiert") ||
      built.process_answer.direct_answer.includes("nicht dokumentiert") ||
      built.process_answer.direct_answer === ANSWER_CONTRACT_NO_PROCESS_MSG ||
      built.process_answer.open.length > 0,
  );
  console.log("ok strip unverifiable confirmed");
}

function testEvidenceContextDiversify() {
  const hits = [
    hit({
      rank: 1,
      knowledge_unit_type: "code_unit",
      object_name: "ZOTCO_IMPORT",
      subobject_name: "DELETE_ORDER",
      title: "Optitool alt",
    }),
    hit({
      rank: 2,
      knowledge_unit_type: "code_unit",
      object_name: "ZCO_IMPORT_NEW3",
      subobject_name: "DELETE_ORDER_NEW",
      title: "Optitool neu",
    }),
    hit({
      rank: 3,
      knowledge_unit_type: "control_table",
      object_type: "TABLE",
      object_name: "ZEXTO_PARAMETER",
      title: "Parameter",
    }),
  ];
  const intent = classifyQuestionIntent(
    "Wo wird zwischen Optitool alt und neu unterschieden?",
  );
  const ctx = buildEvidenceContext({ hits, intent });
  assert.ok(ctx.truncation_report.detailed_count >= 2);
  assert.ok(ctx.truncation_report.comparison_sides.has_alt);
  assert.ok(ctx.truncation_report.comparison_sides.has_neu);
  assert.ok(
    ctx.truncation_report.previously_weak_fields_now_included.includes(
      "relations",
    ),
  );
  console.log("ok evidence context diversify comparison");
}

testIntentComparison();
testDemoteOverclaim();
testStripUnverifiableConfirmed();
testEvidenceContextDiversify();
console.log("\nAll answerContract tests passed.");
