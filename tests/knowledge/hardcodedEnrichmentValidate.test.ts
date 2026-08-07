import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateEnrichmentItem } from "@/lib/knowledge/hardcodedValueInventory/validateEnrichmentAnswer";
import type { MaterialEvidencePack } from "@/lib/knowledge/hardcodedValueInventory/prepareHardcodedEvidence";
import { extractAnalysisHint } from "@/lib/knowledge/hardcodedValueInventory/analysisHints";

function pack(partial?: Partial<MaterialEvidencePack>): MaterialEvidencePack {
  return {
    material_number: "000000000000000993",
    occurrence_count: 2,
    master_data: {
      found_in_mara: false,
      mtart: null,
      matkl: null,
      meins: null,
      spart: null,
      note: "test",
    },
    code_hits: [
      {
        source_key: "x",
        object_type: "CLASS",
        object_name: "ZCL_ORDERS_OUT",
        unit_name: "CHANGE_SEGMENT",
        line_number: 10,
        snippet: "IF ls_item-matnr = '000000000000000993'.",
        condition_hint: "Vergleich",
        action_hint: "Sonderlogik",
        tables_fields: ["MATNR"],
        analysis: {
          technical_summary: "Prüft Material in EDI-Segment",
          business_purpose: "EDI-Auftragsposition anpassen",
          special_cases: [],
          hardcoded_values: ["000000000000000993"],
          tables_read: [],
          tables_written: [],
          facts: [],
          confidence: 0.8,
        },
      },
    ],
    allowed_object_names: ["ZCL_ORDERS_OUT"],
    has_cached_analysis: true,
    evidence_strength: "STRONG",
    ...partial,
  };
}

describe("validateEnrichmentItem", () => {
  it("accepts grounded CODE_DERIVED answer", () => {
    const v = validateEnrichmentItem(pack(), {
      material_number: "000000000000000993",
      process_label: "EDI-Auftragsposition Sonderbehandlung",
      condition_summary: "Wenn die Positionsmaterialnummer diesem Wert entspricht.",
      effect_summary: "Die Position wird im IDoc gesondert verarbeitet.",
      process_claim_status: "CODE_DERIVED",
      primary_object: "ZCL_ORDERS_OUT",
      grounded_on: ["snippet", "analysis"],
    });
    assert.equal(v.accepted, true);
    assert.equal(v.process_claim_status, "CODE_DERIVED");
  });

  it("rejects unknown primary object (repairs) but can still accept", () => {
    const v = validateEnrichmentItem(pack(), {
      material_number: "000000000000000993",
      process_label: "EDI Sonderfall",
      condition_summary: "Wenn MATNR dem Literal entspricht.",
      effect_summary: "Sonderbehandlung der Position.",
      process_claim_status: "INFERRED",
      primary_object: "ZCL_UNKNOWN_THING",
      grounded_on: ["snippet"],
    });
    assert.ok(v.repair_notes.includes("primary_object_not_in_evidence"));
    assert.equal(v.primary_object, "ZCL_ORDERS_OUT");
  });

  it("rejects material number mismatch", () => {
    const v = validateEnrichmentItem(pack(), {
      material_number: "999",
      process_label: "x",
      condition_summary: "y",
      effect_summary: "z",
      process_claim_status: "INFERRED",
      primary_object: "ZCL_ORDERS_OUT",
      grounded_on: ["snippet"],
    });
    assert.equal(v.accepted, false);
  });
});

describe("extractAnalysisHint", () => {
  it("reads technical_summary and business_purpose_inferred", () => {
    const h = extractAnalysisHint({
      technical_summary: "Tech",
      business_purpose_inferred: "Biz",
      special_cases: ["case1"],
      facts: [{ text: "fact a", evidence_lines: [] }],
    });
    assert.equal(h?.technical_summary, "Tech");
    assert.equal(h?.business_purpose, "Biz");
    assert.equal(h?.facts[0], "fact a");
  });
});
