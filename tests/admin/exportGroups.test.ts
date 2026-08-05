import assert from "node:assert/strict";
import {
  EXPORT_GROUP_DEFINITIONS,
  listExportGroupDefinitions,
} from "../../src/lib/admin/exportGroups/definitions";
import { EXPORT_GROUP_IDS } from "../../src/lib/admin/exportGroups/types";
import { parseExportGroupId } from "../../src/lib/admin/exportGroups/computeExportGroups";
import {
  SETUP_MAIN_STEP_META,
  computeSetupOverview,
  type ProjectSetupContext,
} from "../../src/lib/admin/setupMainSteps";

const emptyCtx: ProjectSetupContext = {
  customerId: null,
  customerName: null,
  customerSlug: null,
  customerStatus: null,
  productModule: null,
  projectKey: "P01",
  hasGoals: false,
  membershipCount: 0,
  userMembershipCount: 0,
};

function main() {
  assert.equal(EXPORT_GROUP_IDS.length, 3);
  assert.equal(listExportGroupDefinitions().length, 3);

  const zy = EXPORT_GROUP_DEFINITIONS["zy-tables"];
  assert.equal(zy.sapReport, "Z_AI_REPOSITORY_EXPORT");
  assert.equal(zy.exportType, "Z-Tabellen");
  assert.equal(zy.pipeline, "control-tables");
  assert.equal(zy.requiredForMainProgress, true);
  assert.ok(
    zy.rawTargetPaths.includes("raw/control-tables/definitions"),
  );
  assert.ok(zy.rawTargetPaths.includes("raw/control-tables/contents"));

  const classes = EXPORT_GROUP_DEFINITIONS["classes-repo"];
  assert.equal(classes.pipeline, "prepared");
  assert.equal(classes.requiredForMainProgress, false);
  assert.ok((classes.preparedSubtypes?.length ?? 0) >= 5);

  const master = EXPORT_GROUP_DEFINITIONS["master-data"];
  assert.equal(master.pipeline, "prepared");
  assert.ok(master.rawTargetPaths.some((p) => p.includes("master-data")));

  assert.equal(parseExportGroupId("zy-tables"), "zy-tables");
  assert.equal(parseExportGroupId("nope"), null);

  assert.equal(SETUP_MAIN_STEP_META[3].title, "Datenbasis");
  assert.equal(SETUP_MAIN_STEP_META[4].title, "Validierung");
  assert.equal(SETUP_MAIN_STEP_META[5].title, "Export Teil 2 und Feintuning");

  const overview = computeSetupOverview(emptyCtx);
  assert.equal(overview.steps.length, 6);
  if (overview.steps[0]!.progressPercent < 100) {
    for (const step of overview.steps.slice(1)) {
      assert.equal(step.locked, true, `step ${step.id} should be locked`);
    }
  }

  console.log("exportGroups smoke OK");
}

main();
