import assert from "node:assert/strict";
import { classifyAskIntent } from "../../src/lib/knowledge/askOrchestration/classifyAskIntent";
import { evidenceBudgetFor } from "../../src/lib/knowledge/askOrchestration/evidenceBudget";
import { verifyClaims } from "../../src/lib/knowledge/askOrchestration/claimVerifier";

function main() {
  const a = classifyAskIntent("Wie funktioniert das Edeka virtuelle Lager?");
  assert.equal(a.intent, "PROCESS_EXPLANATION");
  assert.ok(a.lexical_seeds.some((s) => /lager|edeka|virtuel/i.test(s)));

  const b = classifyAskIntent(
    "Welche Liefernachrichten werden per IDoc versandt?",
  );
  assert.equal(b.intent, "INVENTORY_AND_AGGREGATION");

  const c = classifyAskIntent("Was wissen wir über ZRAH?");
  assert.equal(c.intent, "OBJECT_LOOKUP");
  assert.ok(c.technical_symbols.includes("ZRAH"));

  const d = classifyAskIntent("Was passiert technisch bei ZECD?");
  assert.equal(d.intent, "TECHNICAL_TRACE");
  assert.ok(d.technical_symbols.includes("ZECD"));

  const budget = evidenceBudgetFor("PROCESS_EXPLANATION");
  assert.equal(budget.min_process_steps, 2);
  assert.equal(budget.max_new_analyses, 20);
  assert.equal(budget.allow_top_k_primary, false);

  const { kept, discarded } = verifyClaims([
    {
      text: "X ist eine Output Type",
      has_authoritative_object_evidence: false,
    },
    {
      text: "Methode prüft Status",
      has_code_evidence: true,
    },
    {
      text: "Vermutlich immer korrekt",
      has_code_evidence: false,
      has_graph_edge: false,
    },
  ]);
  assert.ok(discarded.some((x) => /Output Type/i.test(x.text)));
  assert.ok(kept.some((x) => /Methode/i.test(x.text)));

  console.log("askOrchestration smoke OK");
}

main();
