import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyHardcodedValueIntent } from "@/lib/knowledge/hardcodedValueInventory/classifyHardcodedValueIntent";
import { scanUnitForMaterialHardcodes } from "@/lib/knowledge/hardcodedValueInventory/scanMaterialLiterals";
import { classifyAskIntent } from "@/lib/knowledge/askOrchestration/classifyAskIntent";

describe("HARDCODED_VALUE_INVENTORY intent", () => {
  it("classifies material hardcoded + process question", () => {
    const q =
      "Welche Materialnummern sind hart codiert und welche Geschäftsprozesse werden damit gesteuert?";
    const hc = classifyHardcodedValueIntent(q);
    assert.equal(hc.intent, "HARDCODED_VALUE_INVENTORY");
    assert.equal(hc.requested_value_type, "MATERIAL_NUMBER");
    assert.equal(hc.requested_context, "BUSINESS_PROCESS");

    const ask = classifyAskIntent(q);
    assert.equal(ask.intent, "HARDCODED_VALUE_INVENTORY");
  });

  it("does not classify plain material list as hardcoded inventory", () => {
    const hc = classifyHardcodedValueIntent(
      "Welche Materialien gibt es im System?",
    );
    assert.equal(hc.intent, "NOT_HARDCODED_VALUE");
  });
});

describe("scanUnitForMaterialHardcodes", () => {
  it("accepts MATNR-bound string literal", () => {
    const code = `
METHOD check.
  IF ls_mara-matnr = '000000000012345678'.
    RETURN.
  ENDIF.
ENDMETHOD.
`;
    const scan = scanUnitForMaterialHardcodes(code);
    assert.ok(scan.hits.length >= 1);
    assert.equal(scan.hits[0]!.material_number, "000000000012345678");
    assert.equal(scan.hits[0]!.active_code, true);
  });

  it("rejects year without MATNR on statement", () => {
    const code = `
METHOD x.
  DATA lv_year TYPE n LENGTH 4 VALUE '2024'.
  IF ls_mara-matnr IS NOT INITIAL.
  ENDIF.
ENDMETHOD.
`;
    const scan = scanUnitForMaterialHardcodes(code);
    assert.ok(
      scan.hits.every((h) => h.material_number !== "2024"),
      "year must not be accepted",
    );
  });

  it("rejects plant literal even when unit mentions MATNR elsewhere", () => {
    const code = `
FORM f.
  IF ls_marc-werks = '1000'.
  ENDIF.
  IF ls_marc-matnr = space.
  ENDIF.
ENDFORM.
`;
    const scan = scanUnitForMaterialHardcodes(code);
    assert.ok(!scan.hits.some((h) => h.original_literal === "1000"));
  });

  it("rejects condition type co-occurring with MATNR", () => {
    const code = `
FORM f.
  SELECT * FROM a905 WHERE kschl = 'ZP00' AND matnr IN zmatnr.
ENDFORM.
`;
    const scan = scanUnitForMaterialHardcodes(code);
    assert.ok(!scan.hits.some((h) => h.original_literal === "ZP00"));
  });

  it("rejects BDC field name literals", () => {
    const code = `
FORM f.
  PERFORM bdc_field USING 'RMMG1-MATNR' ls_mara-matnr.
ENDFORM.
`;
    const scan = scanUnitForMaterialHardcodes(code);
    assert.ok(!scan.hits.some((h) => /RMMG1/i.test(h.original_literal)));
  });

  it("marks comment-only literals", () => {
    const code = `
* IF matnr = '9999999999'.
  IF ls_vbap-matnr = '111122223333'.
  ENDIF.
`;
    const scan = scanUnitForMaterialHardcodes(code);
    const active = scan.hits.filter((h) => h.active_code);
    const comments = scan.hits.filter((h) => h.comment_only);
    assert.ok(active.some((h) => h.material_number === "111122223333"));
    assert.ok(comments.some((h) => h.material_number === "9999999999"));
  });

  it("accepts MATNR default literal", () => {
    const code = `
PARAMETERS p_matnr TYPE matnr DEFAULT '000000000012345678'.
`;
    const scan = scanUnitForMaterialHardcodes(code);
    assert.ok(scan.hits.some((h) => h.material_number === "000000000012345678"));
  });
});
