import assert from "node:assert/strict";
import { splitAbapCodeUnits } from "../../src/lib/ingest/sapAbapUnitSplit";
import { extractProgramArtifacts } from "../../src/lib/ingest/sapProgramExtract";

function main() {
  const source = `
REPORT ztest.
INCLUDE zincl.

FORM fill_data USING iv TYPE string.
  SELECT * FROM mara INTO TABLE @DATA(lt).
  CALL FUNCTION 'Z_FM_X'
    EXPORTING
      iv = iv.
  PERFORM helper.
ENDFORM.

FORM helper.
  AUTHORITY-CHECK OBJECT 'S_TCODE' ID 'TCD' FIELD 'SE38'.
  MESSAGE e001(zmsg).
  SUBMIT zother AND RETURN.
  CALL TRANSACTION 'VA01'.
ENDFORM.

CLASS lcl_x DEFINITION.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.

CLASS lcl_x IMPLEMENTATION.
  METHOD run.
    UPDATE zcustom SET status = 'X' WHERE id = '1'.
    me->run( ).
  ENDMETHOD.
ENDCLASS.
`.trim();

  const units = splitAbapCodeUnits(source);
  const types = units.map((u) => `${u.unit_type}:${u.unit_name}`);
  assert.ok(types.includes("FORM:FILL_DATA"));
  assert.ok(types.includes("FORM:HELPER"));
  assert.ok(types.includes("CLASS:LCL_X"));
  assert.ok(types.includes("METHOD:RUN"));

  // No mid-unit cut: FORM body contains PERFORM helper but stays one unit
  const fill = units.find((u) => u.unit_name === "FILL_DATA");
  assert.ok(fill);
  assert.ok(fill!.source_code.includes("ENDFORM"));
  assert.ok(fill!.source_code.includes("CALL FUNCTION"));

  const extract = extractProgramArtifacts(fill!.source_code);
  assert.ok(extract.tables_read.includes("MARA"));
  assert.ok(extract.call_function.includes("Z_FM_X"));
  assert.ok(extract.perform.includes("HELPER"));

  const topExtract = extractProgramArtifacts(source);
  assert.ok(topExtract.include.includes("ZINCL"));

  const helper = extractProgramArtifacts(
    units.find((u) => u.unit_name === "HELPER")!.source_code,
  );
  assert.ok(helper.authority_check.includes("S_TCODE"));
  assert.ok(helper.submit.includes("ZOTHER"));
  assert.ok(helper.call_transaction.includes("VA01"));
  assert.ok(helper.message.some((m) => m.includes("001")));

  const method = extractProgramArtifacts(
    units.find((u) => u.unit_type === "METHOD")!.source_code,
  );
  assert.ok(method.tables_written.includes("ZCUSTOM"));
  assert.ok(method.tables_zy.includes("ZCUSTOM"));

  console.log("sapRepoCode.unit.test.ts: ok");
}

main();
