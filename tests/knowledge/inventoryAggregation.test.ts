import assert from "node:assert/strict";
import { classifyInventoryIntent } from "../../src/lib/knowledge/inventoryAggregation/classifyInventoryIntent";
import { isEdiMedium } from "../../src/lib/knowledge/inventoryAggregation/buildInventory";
import { resolveDeliveryApplication } from "../../src/lib/knowledge/inventoryAggregation/resolveDeliveryApplication";

function main() {
  const q = "Welche Liefernachrichten werden per IDoc versandt?";
  const c = classifyInventoryIntent(q);
  assert.equal(c.intent, "INVENTORY_AND_AGGREGATION");
  assert.equal(c.entity_domain, "DELIVERY_OUTPUT");
  assert.equal(c.requested_filter, "IDOC_OR_EDI");

  const q2 = "Welche Liefernachrichten erzeugen IDocs?";
  assert.equal(classifyInventoryIntent(q2).requested_filter, "IDOC_OR_EDI");

  assert.equal(isEdiMedium("6"), true);
  assert.equal(isEdiMedium("A"), false);
  assert.equal(isEdiMedium("1"), false);

  const app = resolveDeliveryApplication({
    output_types: [
      {
        application: "V2",
        output_type: "LD00",
        kvewe: "B",
        object_id: "x",
        source_table: "T685",
        source_path: "t",
      },
      {
        application: "V3",
        output_type: "RD00",
        kvewe: "B",
        object_id: "y",
        source_table: "T685",
        source_path: "t",
      },
    ],
    texts: [
      {
        application: "V2",
        output_type: "LD00",
        language: "DE",
        text: "Lieferschein",
        source_path: "t",
      },
      {
        application: "V2",
        output_type: "LAVA",
        language: "DE",
        text: "Lieferavis Ausgang",
        source_path: "t",
      },
      {
        application: "V3",
        output_type: "RD00",
        language: "DE",
        text: "Rechnung",
        source_path: "t",
      },
    ],
  });
  assert.equal(app.application, "V2");
  assert.ok(
    app.selection.confidence === "LOW" ||
      app.selection.confidence === "MEDIUM" ||
      app.selection.confidence === "HIGH",
  );
  assert.match(app.reason, /wahrscheinlichste Lieferanwendung/);

  console.log("inventoryAggregation smoke OK");
}

main();
