/**
 *   npx tsx tests/knowledge/symbolContainment.test.ts
 */
import assert from "assert";
import { resolve } from "path";
import { loadEnvFile } from "../../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../../src/lib/localData/root";
import {
  expandSymbolContainmentFromSeeds,
  isSymbolContainmentEligibleToken,
  isSymbolContainmentHit,
  nameContainsTechnicalToken,
} from "../../src/lib/knowledge/symbolContainment";
import { identifierExactMatch } from "../../src/lib/knowledge/exactAuthoritative";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

assert.ok(isSymbolContainmentEligibleToken("OCTOPUS"));
assert.ok(isSymbolContainmentEligibleToken("ZZ_VLAGER"));
assert.ok(!isSymbolContainmentEligibleToken("KOMMUNIKATION"));
assert.ok(!isSymbolContainmentEligibleToken("LAGER"));
assert.ok(!isSymbolContainmentEligibleToken("SAP"));
assert.ok(!isSymbolContainmentEligibleToken("INFO"));
assert.ok(!isSymbolContainmentEligibleToken("AB"));
assert.ok(!isSymbolContainmentEligibleToken("edi"));

assert.ok(nameContainsTechnicalToken("EDIOCTOPUS", "OCTOPUS"));
assert.ok(nameContainsTechnicalToken("LS|EDIOCTOPUS", "OCTOPUS"));
assert.ok(!nameContainsTechnicalToken("OCTOPUS", "OCTOPUS"));
assert.ok(!identifierExactMatch("LS|EDIOCTOPUS", "OCTOPUS"));

const expanded = expandSymbolContainmentFromSeeds({
  projectId: "P01",
  confirmedSeeds: ["OCTOPUS"],
});
assert.ok(expanded.hits.length > 0, "expected EDIOCTOPUS-style candidates");
assert.ok(
  expanded.hits.some(
    (h) =>
      /EDIOCTOPUS/i.test(h.title) ||
      /EDIOCTOPUS/i.test(h.object_name) ||
      /EDIOCTOPUS/i.test(String(h.metadata?.containment_variant ?? "")),
  ),
  "EDIOCTOPUS should appear as containment candidate",
);
assert.ok(expanded.hits.every((h) => isSymbolContainmentHit(h)));
assert.ok(
  expanded.hits.every(
    (h) => h.metadata?.containment_relation === "name_substring_candidate",
  ),
);
assert.ok(
  !expanded.hits.some((h) => h.metadata?.exact_authoritative === true),
  "containment must not mark authoritative",
);

// Negatives: stop / generic tokens must not fan out.
for (const bad of ["LAGER", "SAP", "INFO", "AB", "EDI"]) {
  const r = expandSymbolContainmentFromSeeds({
    projectId: "P01",
    confirmedSeeds: [bad],
  });
  assert.equal(
    r.hits.length,
    0,
    `${bad} must not produce containment hits (got ${r.hits.length})`,
  );
  assert.ok(
    r.trace.some((t) => t.seed === bad && (t.skip_reason || t.variants.length === 0)),
  );
}

console.log(
  JSON.stringify(
    {
      octopus_variants: expanded.variants.slice(0, 8),
      octopus_trace: expanded.trace,
      hit_titles: expanded.hits.slice(0, 8).map((h) => h.title),
    },
    null,
    2,
  ),
);
console.log("symbolContainment.test.ts: ok");
