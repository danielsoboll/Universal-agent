import assert from "node:assert/strict";
import { buildFailClosedSummary } from "../../src/lib/knowledge/structuredAnswer/failClosedSummary";
import {
  cleanEntityName,
  isDisplayableEntityName,
} from "../../src/lib/knowledge/structuredAnswer/claimContract";

function main() {
  assert.equal(isDisplayableEntityName("Ø"), false);
  assert.equal(isDisplayableEntityName("∅"), false);
  assert.equal(isDisplayableEntityName("ZCL_X"), true);
  assert.equal(cleanEntityName("ZRAH|∅"), "ZRAH");

  const fail = buildFailClosedSummary({
    sufficient: false,
    base_summary: "",
    confirmed: [
      {
        claim_text: "ZCL_X existiert im Codebestand",
        claim_status: "AUTHORITATIVE",
        evidence_ids: [],
        confidence: 0.95,
        source_types: ["canonical"],
      },
    ],
    missing: ["Methodenanalyse", "Prozesspfad"],
    answer_type: "OBJECT_LOOKUP",
  });
  assert.match(fail, /sicher belegt/);
  assert.match(fail, /Noch nicht belegt/);
  assert.match(fail, /fehlt/);

  console.log("structuredAnswer smoke OK");
}

main();
