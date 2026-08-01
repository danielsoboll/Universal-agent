import assert from "node:assert/strict";
import {
  SETUP_MAIN_STEP_IDS,
  SETUP_MAIN_STEP_META,
  computeSetupOverview,
  type ProjectSetupContext,
} from "../../src/lib/admin/setupMainSteps";

/** Activation lock unit smoke (no LOCAL_DATA_ROOT required for step-1-only assertions). */

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
  for (const id of SETUP_MAIN_STEP_IDS) {
    assert.equal(SETUP_MAIN_STEP_META[id].id, id);
    assert.ok(SETUP_MAIN_STEP_META[id].title.length > 0);
  }

  assert.equal(SETUP_MAIN_STEP_META[1].title, "Initialisierung");
  assert.equal(SETUP_MAIN_STEP_META[2].title, "Projekt- und Agent-Struktur");
  assert.equal(SETUP_MAIN_STEP_META[3].title, "Exporte Teil 1");
  assert.equal(SETUP_MAIN_STEP_META[4].title, "Validierung");
  assert.equal(SETUP_MAIN_STEP_META[5].title, "Export Teil 2 und Feintuning");
  assert.equal(SETUP_MAIN_STEP_META[6].title, "Schulung und Nutzung");

  // Without LOCAL_DATA_ROOT, compute may set localDataError — still must lock 2–6
  // if step 1 is not done.
  try {
    const overview = computeSetupOverview(emptyCtx);
    assert.equal(overview.steps[0]?.active, true);
    assert.equal(overview.steps[0]?.locked, false);
    if (overview.steps[0]!.progressPercent < 100) {
      for (const step of overview.steps.slice(1)) {
        assert.equal(step.locked, true, `step ${step.id} should be locked`);
        assert.equal(step.active, false);
        assert.equal(step.progressPercent, 0);
      }
    }
    console.log(
      "setupMainSteps smoke OK",
      overview.overallPercent,
      overview.doneCount,
      overview.localDataError ? "local-err" : "local-ok",
    );
  } catch (e) {
    // If LOCAL_DATA_ROOT missing, compute still runs (catches internally).
    throw e;
  }
}

main();
