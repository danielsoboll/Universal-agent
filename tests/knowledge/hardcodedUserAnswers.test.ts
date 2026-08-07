import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHardcodedUserAnswers } from "@/lib/knowledge/hardcodedValueInventory/buildHardcodedUserAnswers";
import type { HardcodedValueAnswerView } from "@/lib/knowledge/hardcodedValueInventory/types";

const sampleView: HardcodedValueAnswerView = {
  summary: {
    text: "Im kundeneigenen Code sind 2 fest hinterlegte Materialnummern an 3 aktiven Stellen belegt.",
    unique_material_count: 2,
    active_occurrence_count: 3,
    comment_only_count: 0,
    excluded_literal_count: 1,
    units_scanned: 100,
    units_with_matnr_context: 40,
  },
  materials: [
    {
      material_number: "000000000000000993",
      material_number_internal: "993",
      occurrence_count: 2,
      process_label: "EDI-/Belegverarbeitung",
      condition_summary: "Wenn MATNR dem Literal entspricht.",
      effect_summary: "Sonderlogik greift.",
      evidence_status: "Im Code belegt",
      claim_status: "CODE_DERIVED",
      occurrences: [
        {
          material_number: "000000000000000993",
          material_number_internal: "993",
          original_literal: "'000000000000000993'",
          source_key: "class:ZCL_X:METHOD_A",
          object_type: "CLASS",
          object_name: "ZCL_X",
          unit_name: "METHOD_A",
          unit_type: "METHOD",
          line_number: 10,
          snippet: "IF ls_item-matnr = '000000000000000993'.",
          condition: "MATNR-Vergleich",
          action: "Sonderbehandlung",
          tables_fields: ["MATNR"],
          active_code: true,
          comment_only: false,
          confidence: 0.9,
          claim_status: "CODE_DERIVED",
          process_label: "EDI-/Belegverarbeitung",
          process_rationale: null,
        },
      ],
    },
  ],
  multi_use: [],
  comment_or_unclear: [],
  excluded_sample: [{ literal: "2024", reason: "Jahr ohne MATNR-Bindung" }],
  missing_information: ["MAKT fehlt in der Datenbasis."],
  sources: ["canonical/classes"],
};

describe("buildHardcodedUserAnswers", () => {
  it("builds process and technical blocks for Anwender", () => {
    const out = buildHardcodedUserAnswers(sampleView);
    assert.ok(out.process_answer.direct_answer.includes("2 fest hinterlegte"));
    assert.ok(out.process_answer.confirmed.length > 0);
    assert.ok(out.process_answer.business_interpretation.includes("EDI"));
    assert.ok(out.technical_answer.processing.length > 0);
    assert.ok(out.technical_answer.objects.length > 0);
    assert.ok(out.compact_technical_details.beleg.length > 0);
    assert.ok(out.compact_technical_details.ausloeser.length > 0);
    assert.ok(out.technical_details.hardcoded_values.length > 0);
  });
});
