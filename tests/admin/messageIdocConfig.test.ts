import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { getExportTypeConfig } from "../../src/lib/admin/datenbasis/exportTypeConfig";
import {
  CONFIG_GROUPS,
  EXPECTED_GROUPS,
  PIPELINE_TYPE,
  CANONICAL_OBJECT_TYPES,
} from "../../src/lib/admin/datenbasis/messageIdocConfig/constants";
import { extractConfigGroupFromFileName } from "../../src/lib/admin/datenbasis/messageIdocConfig/detectRaw";
import {
  deriveAreaStatus,
  prepareMessageIdocConfig,
} from "../../src/lib/admin/datenbasis/messageIdocConfig/runPrepare";
import {
  validateAndProfileJsonlFile,
  validateHeaderObject,
} from "../../src/lib/admin/datenbasis/messageIdocConfig/validateAndProfile";

function header(group: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "2.9",
    record_type: "header",
    system_id: "D01",
    client: "100",
    export_type: "MESSAGE_IDOC_CONFIG",
    config_group: group,
    tables_found: 2,
    tables_missing: 0,
    rows_exported: 2,
    missing_table_names: "",
    movement_data_included: false,
    object_selection_applied: false,
    ...overrides,
  };
}

function dataRow(
  group: string,
  table: string,
  values: Record<string, unknown>,
) {
  return {
    record_type: "configuration_row",
    config_group: group,
    source_table: table,
    values,
  };
}

async function main() {
  const cfg = getExportTypeConfig("message-idoc-config");
  assert.ok(cfg);
  assert.equal(cfg!.headerExportType, "MESSAGE_IDOC_CONFIG");
  assert.equal(cfg!.minFiles, 10);
  assert.equal(cfg!.filenamePattern, null);
  assert.equal(EXPECTED_GROUPS, 10);
  assert.equal(CONFIG_GROUPS.length, 10);
  assert.ok(CANONICAL_OBJECT_TYPES.includes("logical_system"));
  assert.ok(CANONICAL_OBJECT_TYPES.includes("ale_model_assignment"));
  assert.ok(
    !(CANONICAL_OBJECT_TYPES as readonly string[]).includes("idoc_basic_type"),
  );

  assert.equal(
    extractConfigGroupFromFileName(
      "D01_20260805_151000_MESSAGE_IDOC_01_OUTPUT_TYPES.jsonl",
    ),
    "MESSAGE_IDOC_01_OUTPUT_TYPES",
  );
  assert.equal(
    extractConfigGroupFromFileName(
      "Q01_20260101_000001_MESSAGE_IDOC_10_ALE_ROUTING.jsonl",
    ),
    "MESSAGE_IDOC_10_ALE_ROUTING",
  );
  assert.equal(extractConfigGroupFromFileName("random.jsonl"), null);

  const hdrOk = validateHeaderObject(
    header("MESSAGE_IDOC_01_OUTPUT_TYPES"),
    "MESSAGE_IDOC_01_OUTPUT_TYPES",
  );
  assert.equal(hdrOk.errors.length, 0);

  const hdrBad = validateHeaderObject(
    header("MESSAGE_IDOC_01_OUTPUT_TYPES", {
      movement_data_included: true,
      object_selection_applied: true,
    }),
    "MESSAGE_IDOC_01_OUTPUT_TYPES",
  );
  assert.ok(hdrBad.errors.some((e) => e.includes("movement_data_included")));
  assert.ok(hdrBad.errors.some((e) => e.includes("object_selection_applied")));

  assert.equal(
    deriveAreaStatus({
      detectedGroups: [],
      validated: false,
      profilesWritten: 0,
      readyForMapping: false,
    }),
    "keine_dateien",
  );
  assert.equal(
    deriveAreaStatus({
      detectedGroups: ["MESSAGE_IDOC_01_OUTPUT_TYPES"],
      validated: true,
      profilesWritten: 1,
      readyForMapping: false,
    }),
    "unvollstaendig",
  );
  assert.equal(
    deriveAreaStatus({
      detectedGroups: [...CONFIG_GROUPS],
      validated: true,
      profilesWritten: 5,
      readyForMapping: true,
    }),
    "bereit_fuer_mapping",
  );

  const root = mkdtempSync(path.join(tmpdir(), "msg-idoc-v2-"));
  const prev = process.env.LOCAL_DATA_ROOT;
  process.env.LOCAL_DATA_ROOT = root;
  try {
    const project = "P01";
    const rawDir = path.join(root, project, "raw", "message-idoc-config");
    mkdirSync(rawDir, { recursive: true });

    const g1 = "MESSAGE_IDOC_01_OUTPUT_TYPES";
    writeFileSync(
      path.join(rawDir, `D01_20260805_151000_${g1}.jsonl`),
      [
        JSON.stringify(header(g1, { rows_exported: 3, tables_found: 2 })),
        JSON.stringify(dataRow(g1, "T685", { KSCHL: "ZD00", KAPPL: "V1" })),
        JSON.stringify(dataRow(g1, "T685T", { KSCHL: "ZD00", VTEXT: "Test" })),
        JSON.stringify(dataRow(g1, "T685", { KSCHL: "ZD01", KAPPL: "V1" })),
        "{bad",
      ].join("\n") + "\n",
      "utf8",
    );

    // Incomplete set: only group 02 additionally
    const g2 = "MESSAGE_IDOC_02_OUTPUT_PROCESSING";
    writeFileSync(
      path.join(rawDir, `D01_20260805_151001_${g2}.jsonl`),
      [
        JSON.stringify(
          header(g2, {
            tables_found: 1,
            tables_missing: 0,
            rows_exported: 1,
          }),
        ),
        JSON.stringify(
          dataRow(g2, "TNAPR", { KSCHL: "ZD00", PROGN: "ZSD_NACHA" }),
        ),
      ].join("\n") + "\n",
      "utf8",
    );

    // Group with all tables missing
    const g3 = "MESSAGE_IDOC_03_ALE_MESSAGE_TYPES";
    writeFileSync(
      path.join(rawDir, `D01_20260805_151002_${g3}.jsonl`),
      JSON.stringify(
        header(g3, {
          tables_found: 0,
          tables_missing: 3,
          rows_exported: 0,
          missing_table_names: "EDMSG,EDMSGT,EDIMSGT",
        }),
      ) + "\n",
      "utf8",
    );

    const abs1 = path.join(rawDir, `D01_20260805_151000_${g1}.jsonl`);
    const profiled = await validateAndProfileJsonlFile(abs1, {
      fileName: `D01_20260805_151000_${g1}.jsonl`,
      relativePath: `raw/message-idoc-config/D01_20260805_151000_${g1}.jsonl`,
      bytes: 100,
      configGroupFromFileName: g1,
    });
    assert.equal(profiled.formalStatus, "validation_errors"); // has bad line
    assert.equal(profiled.rowsRead, 3);
    assert.equal(profiled.rowsBySourceTable.T685, 2);
    assert.equal(profiled.rowsBySourceTable.T685T, 1);
    assert.equal(profiled.tableProfiles.length, 2);
    assert.ok(
      profiled.tableProfiles.some((p) => p.source_table === "T685"),
    );

    const res = await prepareMessageIdocConfig(project);
    assert.equal(res.ok, true);
    assert.equal(res.manifest.pipeline_type, PIPELINE_TYPE);
    assert.equal(res.manifest.expected_groups, 10);
    assert.equal(res.manifest.detected_groups.length, 3);
    assert.equal(res.manifest.missing_groups.length, 7);
    assert.equal(res.status.status, "unvollstaendig");

    const f1 = res.manifest.files.find((f) =>
      f.fileName.includes("OUTPUT_TYPES"),
    );
    assert.ok(f1);
    assert.equal(f1!.config_group, g1);
    assert.ok(f1!.rows_by_source_table.T685 >= 1);

    const f3 = res.manifest.files.find((f) =>
      f.fileName.includes("ALE_MESSAGE"),
    );
    assert.ok(f3);
    assert.equal(f3!.formal_status, "keine_unterstuetzten_quelltabellen");
    assert.deepEqual(f3!.missing_table_names, [
      "EDIMSGT",
      "EDMSG",
      "EDMSGT",
    ]);

    const profilePath = path.join(
      root,
      project,
      "logs",
      "message-idoc-config",
      "schema-profiles",
      "MESSAGE_IDOC_01_OUTPUT_TYPES__T685.json",
    );
    assert.ok(existsSync(profilePath));
    const t685 = JSON.parse(readFileSync(profilePath, "utf8"));
    assert.equal(t685.source_table, "T685");
    assert.ok(t685.detectedFieldNames.includes("KSCHL"));

    // Full 10 groups → bereit für mapping
    for (const g of CONFIG_GROUPS) {
      if (
        g === g1 ||
        g === g2 ||
        g === g3
      ) {
        continue;
      }
      writeFileSync(
        path.join(rawDir, `D01_20260805_152000_${g}.jsonl`),
        [
          JSON.stringify(
            header(g, {
              tables_found: 1,
              tables_missing: 0,
              rows_exported: 1,
            }),
          ),
          JSON.stringify(
            dataRow(g, "DUMMY", { KEY: "1", VALUE: "x" }),
          ),
        ].join("\n") + "\n",
        "utf8",
      );
    }
    // Fix g1 file without invalid line for cleaner ready state
    writeFileSync(
      path.join(rawDir, `D01_20260805_151000_${g1}.jsonl`),
      [
        JSON.stringify(header(g1, { rows_exported: 2, tables_found: 2 })),
        JSON.stringify(dataRow(g1, "T685", { KSCHL: "ZD00" })),
        JSON.stringify(dataRow(g1, "T685T", { KSCHL: "ZD00", VTEXT: "T" })),
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(rawDir, `D01_20260805_151002_${g3}.jsonl`),
      [
        JSON.stringify(
          header(g3, {
            tables_found: 1,
            tables_missing: 2,
            rows_exported: 1,
            missing_table_names: "EDMSGT,EDIMSGT",
          }),
        ),
        JSON.stringify(dataRow(g3, "EDMSG", { MSGTYP: "ORDERS" })),
      ].join("\n") + "\n",
      "utf8",
    );

    const full = await prepareMessageIdocConfig(project);
    assert.equal(full.manifest.detected_groups.length, 10);
    assert.equal(full.manifest.missing_groups.length, 0);
    assert.equal(full.status.status, "bereit_fuer_mapping");
  } finally {
    if (prev === undefined) delete process.env.LOCAL_DATA_ROOT;
    else process.env.LOCAL_DATA_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }

  console.log("messageIdocConfig.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
