/**
 *   npx tsx tests/search/technicalSymbols.test.ts
 */
import assert from "assert";
import {
  extractTechnicalSymbols,
  haystackMatchesSymbol,
} from "../../src/lib/search/technicalSymbols";
import { draftFromMasterFieldDefinition } from "../../src/lib/search/adapters/masterFieldDefinition";

const zecd = extractTechnicalSymbols("Was wissen wir über die Nachricht ZECD?");
assert.ok(zecd.some((s) => s.norm === "ZECD"), "ZECD must be extracted");

const vlager = extractTechnicalSymbols(
  "Wie funktioniert das Edeka virtuelle Lager? KNVV-ZZ_VLAGER",
);
assert.ok(vlager.some((s) => s.norm === "ZZ_VLAGER"));
assert.ok(vlager.some((s) => s.norm === "KNVV-ZZ_VLAGER" || s.norm === "KNVV"));

assert.ok(haystackMatchesSymbol("SELECT ZZ_VLAGER FROM KNVV", "ZZ_VLAGER"));

const draft = draftFromMasterFieldDefinition({
  field: {
    table_name: "KNVV",
    field_name: "ZZ_VLAGER",
    description: "Kennzeichen virtuelles Lager",
    data_element: "ZZ_SD_VLAGER",
    domain: "XFELD",
    data_type: "CHAR",
    length: 1,
    system_id: "Q01",
    _is_z_field: true,
  },
});
assert.ok(draft);
assert.strictEqual(draft!.knowledge_unit_type, "master_field");
assert.ok(draft!.title.includes("KNVV"));
assert.ok(draft!.title.includes("ZZ_VLAGER"));
assert.ok(
  (draft!.facts ?? []).some((f) => f.includes("Kennzeichen virtuelles Lager")),
);
assert.ok(
  (draft!.facts ?? []).some((f) => f.includes("ZZ_SD_VLAGER")),
);

console.log("technicalSymbols.test.ts — OK");
