import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractLiteralsFromAbap } from "@/lib/portableIndex/extractLiterals";

const meta = {
  project_id: "P01",
  system_id: "D01",
  source_key: "CLASS|D01|ZCL_X|METHOD|CHECK",
  source_path: "canonical/classes/code_units.jsonl",
  object_type: "METHOD",
  object_name: "ZCL_X",
  class_name: "ZCL_X",
  method_or_routine: "CHECK",
  code_unit_id: "ZCL_X.CHECK",
};

describe("extractLiteralsFromAbap", () => {
  it("indexes MATNR-bound material literal with candidate role", () => {
    const code = `
METHOD check.
  IF ls_mara-matnr = '000000000000004711'.
    RETURN.
  ENDIF.
ENDMETHOD.
`;
    const hits = extractLiteralsFromAbap(code, meta);
    const mat = hits.find((h) => h.normalized_value === "4711");
    assert.ok(mat, "4711 must be findable");
    assert.ok(mat!.bound_fields.includes("MATNR"));
    assert.ok(mat!.candidate_roles.includes("material_number"));
    assert.equal(mat!.source_key, meta.source_key);
    assert.ok(!mat!.statement_preview.includes("METHOD check"));
  });

  it("still indexes unbound 4711 for exact find, without material role", () => {
    const code = `
METHOD x.
  DATA lv TYPE string VALUE '4711'.
ENDMETHOD.
`;
    const hits = extractLiteralsFromAbap(code, meta);
    const lit = hits.find((h) => h.literal_value === "4711");
    assert.ok(lit, "exact find must keep unbound literals");
    assert.equal(lit!.bound_fields.length, 0);
    assert.ok(lit!.candidate_roles.includes("generic_literal"));
    assert.ok(!lit!.candidate_roles.includes("material_number"));
  });

  it("binds VKORG plant-like org literal", () => {
    const code = `
FORM f.
  IF ls_vbak-vkorg = '1000'.
  ENDIF.
ENDFORM.
`;
    const hits = extractLiteralsFromAbap(code, meta);
    const hit = hits.find((h) => h.literal_value === "1000");
    assert.ok(hit);
    assert.ok(hit!.bound_fields.includes("VKORG"));
    assert.ok(hit!.candidate_roles.includes("sales_org"));
  });

  it("indexes CALL FUNCTION name as function_module", () => {
    const code = `CALL FUNCTION 'BAPI_MATERIAL_GET_DETAIL'.`;
    const hits = extractLiteralsFromAbap(code, meta);
    const hit = hits.find((h) => h.literal_value === "BAPI_MATERIAL_GET_DETAIL");
    assert.ok(hit);
    assert.equal(hit!.literal_type, "function_module");
  });

  it("does not duplicate full source into records", () => {
    const code = "IF matnr = '4711'. " + "X".repeat(5000);
    const hits = extractLiteralsFromAbap(code, meta);
    for (const h of hits) {
      assert.ok(h.statement_preview.length <= 220);
      assert.ok(!("source_code" in h));
    }
  });
});
