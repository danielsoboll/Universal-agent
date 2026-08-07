import assert from "node:assert/strict";
import {
  getExportTypeConfig,
  listExportTypeConfigs,
} from "../../src/lib/admin/datenbasis/exportTypeConfig";
import {
  createInitialManifest,
  DATENBASIS_PROGRESS,
  DATENBASIS_STEP_WEIGHTS,
  isCanonicalReady,
  nextActionLabel,
  progressPercent,
} from "../../src/lib/admin/datenbasis/manifestStore";
import { DATENBASIS_STEP_IDS } from "../../src/lib/admin/datenbasis/types";
import {
  canonicalizeMaterialsExport,
  materialsValidationOk,
} from "../../src/lib/ingest/materialsCanonical";
import {
  canonicalizeMasterDataExport,
  enrichMasterStructureRecord,
  masterDataValidationOk,
} from "../../src/lib/ingest/masterDataCanonical";
import {
  CUSTOMERS_DOMAIN,
  VENDORS_DOMAIN,
} from "../../src/lib/admin/datenbasis/masterDataDomain";

function main() {
  const configs = listExportTypeConfigs();
  assert.ok(configs.length >= 2);
  assert.equal(configs[0]!.id, "classes");
  assert.equal(configs[0]!.implementation, "full");
  assert.equal(configs[0]!.headerExportType, "SAP_CLASSES");
  assert.equal(configs[0]!.filenamePattern, null);

  const classes = getExportTypeConfig("classes");
  assert.ok(classes);
  assert.equal(classes!.rawFolder, "raw/classes");
  assert.ok(
    classes!.certainty === "inferred_from_raw" ||
      classes!.certainty === "verified",
  );

  const materials = getExportTypeConfig("materials");
  assert.ok(materials);
  assert.equal(materials!.implementation, "full");
  assert.equal(materials!.unlockIndependent, true);
  assert.equal(materials!.certainty, "inferred_from_raw");
  assert.ok(materials!.filenamePattern instanceof RegExp);
  assert.equal(materials!.headerExportType, null);
  assert.equal(materials!.rawFolder, "raw/master-data/materials");
  assert.deepEqual(materials!.rawFolderParts, ["master-data", "materials"]);
  assert.ok(materials!.headerRules?.record_type?.exact === "header");
  assert.equal(materials!.headerRules?.export_type?.exact ?? null, null);
  assert.ok(materials!.headerRules?.table_name?.required);
  assert.ok(
    (materials!.canonicalOutputs ?? []).some((p) =>
      p.includes("canonical/master-data/materials"),
    ),
  );

  // No Stammdaten-Rahmen scaffold; unique display order indices
  assert.equal(getExportTypeConfig("master-data"), null);
  const orderIndexes = configs.map((c) => c.orderIndex);
  assert.equal(new Set(orderIndexes).size, orderIndexes.length);

  const messageIdoc = getExportTypeConfig("message-idoc-config");
  assert.ok(messageIdoc);
  assert.equal(messageIdoc!.implementation, "prepared");
  assert.equal(messageIdoc!.unlockIndependent, true);
  assert.equal(messageIdoc!.rawFolder, "raw/message-idoc-config");
  assert.equal(messageIdoc!.filenamePattern, null);
  assert.equal(messageIdoc!.headerExportType, "MESSAGE_IDOC_CONFIG");
  assert.equal(messageIdoc!.minFiles, 10);
  assert.equal(messageIdoc!.certainty, "inferred_from_raw");

  const programs = getExportTypeConfig("programs");
  assert.ok(programs);
  assert.equal(programs!.certainty, "inferred_from_raw");
  assert.equal(programs!.implementation, "full");
  assert.equal(programs!.headerExportType, "SAP_PROGRAMS");
  assert.equal(programs!.rawFolder, "raw/programs");
  assert.ok(programs!.unlockIndependent);
  assert.ok(
    (programs!.canonicalOutputs ?? []).some((p) =>
      p.includes("canonical/programs"),
    ),
  );

  const fms = getExportTypeConfig("function-modules");
  assert.ok(fms);
  assert.equal(fms!.certainty, "inferred_from_raw");
  assert.equal(fms!.implementation, "full");
  assert.equal(fms!.headerExportType, "SAP_FUNCTION_MODULES");
  assert.equal(fms!.rawFolder, "raw/programs");
  assert.ok(fms!.unlockIndependent);

  // Feste Fortschritts-Logik: Gewichte + Meilensteine
  const weightSum = DATENBASIS_STEP_IDS.reduce(
    (s, id) => s + DATENBASIS_STEP_WEIGHTS[id],
    0,
  );
  assert.equal(weightSum, 100);
  assert.equal(DATENBASIS_PROGRESS.CANONICAL_READY_PERCENT, 40);
  assert.equal(DATENBASIS_PROGRESS.AFTER_TESTS_PERCENT, 55);
  assert.equal(DATENBASIS_PROGRESS.AFTER_INDEX_PERCENT, 85);

  const m = createInitialManifest("P01", classes!, true);
  assert.equal(m.steps.A_sap_export.status, "ready");
  assert.equal(m.steps.B_raw_detect.status, "open");
  assert.equal(progressPercent(m), 0);

  // A–D done = 40 % (Canonical bereit, Index ausstehend)
  const weighted = createInitialManifest("P01", materials!, true);
  for (const id of [
    "A_sap_export",
    "B_raw_detect",
    "C_validate",
    "D_convert",
  ] as const) {
    weighted.steps[id] = { ...weighted.steps[id], status: "done" };
  }
  weighted.overall = "in_progress";
  assert.equal(isCanonicalReady(weighted), true);
  assert.equal(
    progressPercent(weighted),
    DATENBASIS_PROGRESS.CANONICAL_READY_PERCENT,
  );
  assert.equal(
    nextActionLabel(weighted).label,
    DATENBASIS_PROGRESS.LABEL_CANONICAL_READY,
  );

  weighted.steps.E_test_questions = {
    ...weighted.steps.E_test_questions,
    status: "done",
  };
  assert.equal(
    progressPercent(weighted),
    DATENBASIS_PROGRESS.AFTER_TESTS_PERCENT,
  );
  assert.equal(
    nextActionLabel(weighted).label,
    DATENBASIS_PROGRESS.LABEL_INDEX_PENDING,
  );

  weighted.steps.F_rag_test = {
    ...weighted.steps.F_rag_test,
    status: "done",
  };
  assert.equal(
    progressPercent(weighted),
    DATENBASIS_PROGRESS.AFTER_INDEX_PERCENT,
  );
  assert.equal(
    nextActionLabel(weighted).label,
    DATENBASIS_PROGRESS.LABEL_APPROVAL_PENDING,
  );

  weighted.steps.G_approve = {
    ...weighted.steps.G_approve,
    status: "done",
  };
  weighted.overall = "approved";
  assert.equal(progressPercent(weighted), 100);

  const mm = createInitialManifest("P01", materials!, true);
  assert.equal(mm.steps.A_sap_export.status, "ready");
  assert.equal(mm.export_type, "materials");

  // Deterministic materials canonicalize (synthetic — no invented MARA fields)
  const sample = [
    JSON.stringify({
      schema_version: "1.0",
      record_type: "header",
      system_id: "D01",
      export_type: "OBSERVED_PLACEHOLDER",
    }),
    JSON.stringify({
      schema_version: "1.0",
      record_type: "material_row",
      system_id: "D01",
      matnr: "000000000000000001",
      maktx: "Test",
    }),
    JSON.stringify({
      schema_version: "1.0",
      record_type: "material_row",
      system_id: "D01",
      matnr: "000000000000000002",
    }),
  ].join("\n");

  const canon = canonicalizeMaterialsExport({
    text: sample,
    sourceFileName: "synthetic.jsonl",
    sourceBytes: Buffer.byteLength(sample, "utf8"),
  });
  assert.equal(canon.stats.headers, 1);
  assert.equal(canon.stats.body_records, 2);
  assert.equal(canon.observed_export_type, "OBSERVED_PLACEHOLDER");
  assert.ok(materialsValidationOk(canon));
  assert.ok(canon.records[0]!._canonical_key.includes("000000000000000001"));

  const bad = canonicalizeMaterialsExport({
    text: '{"record_type":"header"}\nnot-json\n',
    sourceFileName: "bad.jsonl",
    sourceBytes: 40,
  });
  assert.ok(!materialsValidationOk(bad));
  assert.ok(bad.stats.invalid >= 1);

  const customers = getExportTypeConfig("customers");
  assert.ok(customers);
  assert.equal(customers!.implementation, "full");
  assert.equal(customers!.unlockIndependent, true);
  assert.equal(customers!.rawFolder, "raw/master-data/customers");
  assert.deepEqual(customers!.rawFolderParts, ["master-data", "customers"]);
  assert.equal(customers!.minFiles, 8);
  assert.ok(
    (customers!.canonicalOutputs ?? []).some((p) =>
      p.includes("canonical/master-data/customers/relations.jsonl"),
    ),
  );

  const vendors = getExportTypeConfig("vendors");
  assert.ok(vendors);
  assert.equal(vendors!.implementation, "full");
  assert.equal(vendors!.unlockIndependent, true);
  assert.equal(vendors!.rawFolder, "raw/master-data/vendors");
  assert.deepEqual(vendors!.rawFolderParts, ["master-data", "vendors"]);
  assert.equal(vendors!.minFiles, 4);

  assert.deepEqual([...CUSTOMERS_DOMAIN.tables], [
    "KNA1",
    "KNVV",
    "KNVP",
    "KNVH",
  ]);
  assert.deepEqual([...VENDORS_DOMAIN.tables], ["LFA1", "LFM1"]);
  assert.ok(CUSTOMERS_DOMAIN.relations.some((r) => r.id === "kna1_to_knvv"));
  assert.ok(VENDORS_DOMAIN.relations.some((r) => r.id === "lfa1_to_lfm1"));

  const custSample = [
    JSON.stringify({
      schema_version: "2.8",
      record_type: "header",
      system_id: "Q01",
      export_type: "MASTER_CONTENT",
      table_name: "KNA1",
      profile: "CUSTOMER",
    }),
    JSON.stringify({
      schema_version: "2.8",
      record_type: "master_data_row",
      table_name: "KNA1",
      row_number: 1,
      values: { KUNNR: "0000000001" },
    }),
  ].join("\n");
  const custCanon = canonicalizeMasterDataExport({
    text: custSample,
    sourceFileName: "customer_synth.jsonl",
    sourceBytes: Buffer.byteLength(custSample, "utf8"),
    options: { contentKeyFields: CUSTOMERS_DOMAIN.contentKeyFields },
  });
  assert.ok(masterDataValidationOk(custCanon));
  assert.equal(custCanon.observed_profile, "CUSTOMER");
  assert.ok(custCanon.records[0]!._canonical_key.includes("row:1"));

  const struct = enrichMasterStructureRecord({
    field_name: "ZZTEST",
    included_in_content: true,
    _canonical_key: "t",
    _source_line: 2,
    _content_sha256: "abc",
  });
  assert.equal(struct._is_z_field, true);
  assert.equal(struct._linked_to_content, true);

  const mc = createInitialManifest("P01", customers!, true);
  assert.equal(mc.export_type, "customers");
  const mv = createInitialManifest("P01", vendors!, true);
  assert.equal(mv.export_type, "vendors");

  console.log("datenbasis config smoke OK");
}

main();
