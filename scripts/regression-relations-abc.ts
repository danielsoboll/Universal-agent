/**
 * Offline regression (no OpenAI, no index sync) after MESSAGE_IDOC_11 + repository-relations Pass 1.
 *
 * Cases: ZECD (A), ZRAH (B), ZZ_VLAGER / KNVV-ZZ_VLAGER (C)
 *
 *   npx tsx scripts/regression-relations-abc.ts [--project P01]
 */
import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { createInterface } from "readline";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveWritablePath } from "../src/lib/localData/paths";
import {
  isAuthoritativeOutputTypeKvewe,
  messageIdocObjectIsAuthoritativeOutputType,
} from "../src/lib/domain/typeAuthority";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function* streamJsonl(abs: string): AsyncGenerator<Record<string, unknown>> {
  if (!existsSync(abs)) return;
  const rl = createInterface({
    input: createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as unknown;
        if (o && typeof o === "object" && !Array.isArray(o)) {
          yield o as Record<string, unknown>;
        }
      } catch {
        /* skip */
      }
    }
  } finally {
    rl.close();
  }
}

function includesNeedle(obj: unknown, needle: string): boolean {
  return JSON.stringify(obj).toUpperCase().includes(needle.toUpperCase());
}

async function main() {
  loadEnvFile();
  const projectKey = argValue("--project") ?? "P01";
  void getLocalDataRoot();

  const paths = {
    msgObjects: resolveWritablePath(
      projectKey,
      "canonical",
      "message-idoc-config",
      "objects.jsonl",
    ),
    msgRelations: resolveWritablePath(
      projectKey,
      "canonical",
      "message-idoc-config",
      "relations.jsonl",
    ),
    msgRelationsPrior: resolveWritablePath(
      projectKey,
      "canonical",
      "message-idoc-config",
      "relations.from-groups-01-10.jsonl",
    ),
    msgManifest: resolveWritablePath(
      projectKey,
      "canonical",
      "message-idoc-config",
      "relations-manifest.json",
    ),
    repoObjects: resolveWritablePath(
      projectKey,
      "canonical",
      "repository-relations",
      "objects.jsonl",
    ),
    repoRelations: resolveWritablePath(
      projectKey,
      "canonical",
      "repository-relations",
      "relations.jsonl",
    ),
    repoUnresolved: resolveWritablePath(
      projectKey,
      "canonical",
      "repository-relations",
      "unresolved.jsonl",
    ),
    repoManifest: resolveWritablePath(
      projectKey,
      "canonical",
      "repository-relations",
      "manifest.json",
    ),
    masterFields: resolveWritablePath(
      projectKey,
      "canonical",
      "master-data",
      "customers",
      "records.jsonl",
    ),
    knvvStructure: resolveWritablePath(
      projectKey,
      "canonical",
      "master-data",
      "customers",
      "KNVV",
      "structure.jsonl",
    ),
    knvvContent: resolveWritablePath(
      projectKey,
      "canonical",
      "master-data",
      "customers",
      "KNVV",
      "content.jsonl",
    ),
    controlContents: resolveWritablePath(
      projectKey,
      "canonical",
      "control-tables",
      "table_rows.jsonl",
    ),
    controlDefs: resolveWritablePath(
      projectKey,
      "canonical",
      "control-tables",
      "table_definitions.jsonl",
    ),
    controlEntities: resolveWritablePath(
      projectKey,
      "canonical",
      "control-tables",
      "table_entities.jsonl",
    ),
    controlRelations: resolveWritablePath(
      projectKey,
      "canonical",
      "control-tables",
      "table_relations.jsonl",
    ),
    programsExtracts: resolveWritablePath(
      projectKey,
      "canonical",
      "programs",
      "extracts.jsonl",
    ),
    programsUnits: resolveWritablePath(
      projectKey,
      "canonical",
      "programs",
      "code_units.jsonl",
    ),
    fmExtracts: resolveWritablePath(
      projectKey,
      "canonical",
      "function-modules",
      "extracts.jsonl",
    ),
    classUnits: resolveWritablePath(
      projectKey,
      "canonical",
      "classes",
      "code_units.jsonl",
    ),
  };

  const joint = {
    message_idoc_11: existsSync(paths.msgManifest)
      ? JSON.parse(readFileSync(paths.msgManifest, "utf8"))
      : null,
    repository_relations: existsSync(paths.repoManifest)
      ? JSON.parse(readFileSync(paths.repoManifest, "utf8"))
      : null,
    files: Object.fromEntries(
      Object.entries(paths).map(([k, abs]) => [
        k,
        {
          exists: existsSync(abs),
          bytes: existsSync(abs) ? statSync(abs).size : 0,
        },
      ]),
    ),
  };

  // --- A ZECD ---
  const zecd = {
    authoritative_output_types: [] as Array<Record<string, unknown>>,
    false_output_types: [] as Array<Record<string, unknown>>,
    msg_relations: [] as Array<Record<string, unknown>>,
    prior_relations: [] as Array<Record<string, unknown>>,
    repo_relations: [] as Array<Record<string, unknown>>,
    repo_unresolved: [] as Array<Record<string, unknown>>,
    idoc_partner_relations: [] as Array<Record<string, unknown>>,
  };

  for await (const o of streamJsonl(paths.msgObjects)) {
    if (!includesNeedle(o, "ZECD")) continue;
    const object_type = String(o.object_type ?? "");
    const object_id = String(o.object_id ?? "");
    const attributes = (o.attributes as Record<string, unknown>) ?? {};
    if (object_type === "output_type" || object_type === "output_type_text") {
      const auth = messageIdocObjectIsAuthoritativeOutputType({
        object_type,
        attributes,
      });
      const row = {
        object_type,
        object_id,
        KVEWE: attributes.KVEWE,
        KAPPL: attributes.KAPPL,
        KSCHL: attributes.KSCHL,
        authoritative: auth,
      };
      if (auth) zecd.authoritative_output_types.push(row);
      else zecd.false_output_types.push(row);
    }
  }

  for await (const r of streamJsonl(paths.msgRelations)) {
    if (!includesNeedle(r, "ZECD")) continue;
    zecd.msg_relations.push({
      from_type: r.from_type,
      from_name: r.from_name,
      relation_type: r.relation_type,
      to_type: r.to_type,
      to_name: r.to_name,
      occurrence_count: r.occurrence_count,
      authoritative: r.authoritative,
      source_tables: r.source_tables,
      contexts: r.contexts,
    });
    const rt = String(r.relation_type ?? "");
    if (
      rt.includes("IDOC") ||
      rt.includes("PARTNER") ||
      String(r.from_type).includes("PARTNER") ||
      String(r.to_type).includes("IDOC") ||
      String(r.to_type).includes("MESSAGE")
    ) {
      zecd.idoc_partner_relations.push({
        relation_type: rt,
        from_name: r.from_name,
        to_name: r.to_name,
      });
    }
  }

  for await (const r of streamJsonl(paths.msgRelationsPrior)) {
    if (!includesNeedle(r, "ZECD")) continue;
    zecd.prior_relations.push({
      relation_kind: r.relation_kind,
      from_object_id: r.from_object_id,
      to_object_id: r.to_object_id,
    });
  }

  for await (const r of streamJsonl(paths.repoRelations)) {
    if (!includesNeedle(r, "ZECD")) continue;
    zecd.repo_relations.push({
      from_type: r.from_type,
      from_name: r.from_name,
      relation_type: r.relation_type,
      to_type: r.to_type,
      to_name: r.to_name,
      occurrence_count: r.occurrence_count,
    });
  }
  for await (const r of streamJsonl(paths.repoUnresolved)) {
    if (!includesNeedle(r, "ZECD")) continue;
    zecd.repo_unresolved.push({
      from_name: r.from_name,
      relation_type: r.relation_type,
      to_name: r.to_name,
    });
  }

  // --- B ZRAH ---
  const zrah = {
    output_type_objects: [] as Array<Record<string, unknown>>,
    msg_relations_as_output: [] as Array<Record<string, unknown>>,
    code_hits: [] as Array<Record<string, unknown>>,
    repo_hits: [] as Array<Record<string, unknown>>,
    pricing_config_found: false,
    pricing_config_open: true,
  };

  for await (const o of streamJsonl(paths.msgObjects)) {
    if (!includesNeedle(o, "ZRAH")) continue;
    const object_type = String(o.object_type ?? "");
    if (object_type === "output_type" || object_type === "output_type_text") {
      const attributes = (o.attributes as Record<string, unknown>) ?? {};
      zrah.output_type_objects.push({
        object_type,
        object_id: o.object_id,
        KVEWE: attributes.KVEWE,
        authoritative: messageIdocObjectIsAuthoritativeOutputType({
          object_type,
          attributes,
        }),
        kvewe_is_B: isAuthoritativeOutputTypeKvewe(String(attributes.KVEWE ?? "")),
      });
    }
  }

  for await (const r of streamJsonl(paths.msgRelations)) {
    if (!includesNeedle(r, "ZRAH")) continue;
    if (String(r.from_type) === "OUTPUT_TYPE" || String(r.to_type) === "OUTPUT_TYPE") {
      zrah.msg_relations_as_output.push({
        from_name: r.from_name,
        relation_type: r.relation_type,
        to_name: r.to_name,
      });
    }
  }

  const codeFiles = [
    { abs: paths.programsExtracts, hint: "programs/extracts.jsonl" },
    { abs: paths.programsUnits, hint: "programs/code_units.jsonl" },
    { abs: paths.fmExtracts, hint: "function-modules/extracts.jsonl" },
    { abs: paths.classUnits, hint: "classes/code_units.jsonl" },
  ];
  for (const f of codeFiles) {
    for await (const o of streamJsonl(f.abs)) {
      if (!includesNeedle(o, "ZRAH") && !includesNeedle(o, "GET_ZRAH_PRICE") && !includesNeedle(o, "Z_RVADIN01")) {
        continue;
      }
      const blob = JSON.stringify(o).toUpperCase();
      if (
        blob.includes("ZRAH") ||
        blob.includes("GET_ZRAH_PRICE") ||
        blob.includes("Z_RVADIN01")
      ) {
        zrah.code_hits.push({
          source: f.hint,
          object:
            o.object_name ||
            o.source_key ||
            o.unit_key ||
            o.program_name ||
            o.name ||
            null,
          has_Z_RVADIN01: blob.includes("Z_RVADIN01"),
          has_GET_ZRAH_PRICE: blob.includes("GET_ZRAH_PRICE"),
          has_ZRAH: blob.includes("ZRAH"),
        });
      }
    }
  }

  for await (const r of streamJsonl(paths.repoRelations)) {
    if (!includesNeedle(r, "ZRAH") && !includesNeedle(r, "Z_RVADIN01") && !includesNeedle(r, "GET_ZRAH_PRICE")) {
      continue;
    }
    zrah.repo_hits.push({
      from_name: r.from_name,
      relation_type: r.relation_type,
      to_name: r.to_name,
      occurrence_count: r.occurrence_count,
    });
  }
  for await (const r of streamJsonl(paths.repoUnresolved)) {
    if (!includesNeedle(r, "ZRAH") && !includesNeedle(r, "GET_ZRAH_PRICE")) continue;
    zrah.repo_hits.push({
      unresolved: true,
      from_name: r.from_name,
      relation_type: r.relation_type,
      to_name: r.to_name,
    });
  }

  // Pricing config: look for ZRAH in control tables / message objects that aren't output_type
  let pricingHits = 0;
  for await (const o of streamJsonl(paths.controlContents)) {
    if (includesNeedle(o, "ZRAH")) pricingHits += 1;
  }
  for await (const o of streamJsonl(paths.msgObjects)) {
    if (!includesNeedle(o, "ZRAH")) continue;
    const ot = String(o.object_type ?? "");
    if (ot !== "output_type" && ot !== "output_type_text") pricingHits += 1;
  }
  zrah.pricing_config_found = pricingHits > 0;
  zrah.pricing_config_open = pricingHits === 0;

  // Cap noisy arrays
  zrah.code_hits = zrah.code_hits.slice(0, 40);
  zrah.repo_hits = zrah.repo_hits.slice(0, 40);

  // --- C ZZ_VLAGER ---
  const vlager = {
    field_hits: [] as Array<Record<string, unknown>>,
    code_read: [] as Array<Record<string, unknown>>,
    code_write: [] as Array<Record<string, unknown>>,
    control_tables: [] as Array<Record<string, unknown>>,
    repo_reads: [] as Array<Record<string, unknown>>,
    repo_writes: [] as Array<Record<string, unknown>>,
    ddic_missing: true,
    ddic_hits: [] as Array<Record<string, unknown>>,
  };

  const fieldPaths = [
    paths.masterFields,
    paths.knvvStructure,
    paths.knvvContent,
  ];
  // also search common field index locations
  const extraFieldCandidates = [
    resolveWritablePath(projectKey, "indexes", "search", "documents.jsonl"),
  ];

  for (const abs of [...fieldPaths, ...extraFieldCandidates]) {
    for await (const o of streamJsonl(abs)) {
      if (!includesNeedle(o, "ZZ_VLAGER") && !includesNeedle(o, "KNVV-ZZ_VLAGER")) {
        continue;
      }
      vlager.field_hits.push({
        source: abs.split("/canonical/")[1] || abs.split("/indexes/")[1] || abs,
        key: o.source_key || o.technical_name || o.field_name || o.object_id || null,
        table: o.table_name || o.tabname || null,
        field: o.field_name || o.fieldname || null,
      });
      if (
        includesNeedle(o, "KNVV") &&
        includesNeedle(o, "ZZ_VLAGER")
      ) {
        vlager.ddic_hits.push({
          source: abs.includes("canonical")
            ? abs.split("/canonical/")[1]
            : abs.split("/indexes/")[1] || "indexes",
          preview: JSON.stringify(o).slice(0, 200),
        });
      }
    }
  }

  for await (const o of streamJsonl(paths.controlDefs)) {
    if (!includesNeedle(o, "ZZ_VLAGER") && !includesNeedle(o, "VLAGER") && !includesNeedle(o, "ZZTVAG") && !includesNeedle(o, "ZVLAGER")) {
      continue;
    }
    vlager.control_tables.push({
      source: "control-tables/table_definitions.jsonl",
      table: o.table_name || o.tabname || o.object_name || null,
    });
  }
  for await (const o of streamJsonl(paths.controlContents)) {
    if (!includesNeedle(o, "ZZ_VLAGER") && !includesNeedle(o, "ZZTVAG") && !includesNeedle(o, "ZVLAGER_AUART")) {
      continue;
    }
    vlager.control_tables.push({
      source: "control-tables/table_rows.jsonl",
      table: o.table_name || o.tabname || null,
      key: o.row_key || o.source_key || null,
    });
  }
  for await (const o of streamJsonl(paths.controlEntities)) {
    if (!includesNeedle(o, "ZZ_VLAGER") && !includesNeedle(o, "ZZTVAG") && !includesNeedle(o, "ZVLAGER")) {
      continue;
    }
    vlager.control_tables.push({
      source: "control-tables/table_entities.jsonl",
      table: o.table_name || o.entity_type || null,
      key: o.entity_id || o.source_key || null,
    });
  }
  for await (const o of streamJsonl(paths.controlRelations)) {
    if (!includesNeedle(o, "ZZ_VLAGER") && !includesNeedle(o, "ZZTVAG") && !includesNeedle(o, "ZVLAGER")) {
      continue;
    }
    vlager.control_tables.push({
      source: "control-tables/table_relations.jsonl",
      relation: o.relation_type || null,
      from: o.from_id || o.from_object || null,
      to: o.to_id || o.to_object || null,
    });
  }

  for (const f of codeFiles) {
    for await (const o of streamJsonl(f.abs)) {
      if (!includesNeedle(o, "ZZ_VLAGER") && !includesNeedle(o, "VLAGER")) continue;
      const blob = JSON.stringify(o).toUpperCase();
      const row = {
        source: f.hint,
        object: o.object_name || o.source_key || o.unit_key || o.name || null,
        unit_type: o.unit_type || o.record_type || null,
      };
      const isWrite =
        /UPDATE|MODIFY|INSERT|WRITE|MOVE.*ZZ_VLAGER|ZZ_VLAGER\s*=/.test(blob);
      const isRead =
        /SELECT|READ|IF\s+.*ZZ_VLAGER|ZZ_VLAGER\s*[=<>]|CHECK.*ZZ_VLAGER/.test(
          blob,
        ) || blob.includes("ZZ_VLAGER");
      if (isWrite) vlager.code_write.push(row);
      else if (isRead) vlager.code_read.push(row);
      else vlager.code_read.push(row);
    }
  }

  for await (const r of streamJsonl(paths.repoRelations)) {
    if (!includesNeedle(r, "ZZ_VLAGER") && !includesNeedle(r, "VLAGER")) continue;
    const row = {
      from_name: r.from_name,
      relation_type: r.relation_type,
      to_name: r.to_name,
      occurrence_count: r.occurrence_count,
    };
    if (String(r.relation_type) === "READS_TABLE") vlager.repo_reads.push(row);
    else if (String(r.relation_type) === "WRITES_TABLE") vlager.repo_writes.push(row);
  }

  // DDIC: true DDIC/Strukturdefinition vs. nur Inhaltszeilen mit dem Feldwert
  let structureFieldDef = false;
  for await (const o of streamJsonl(paths.knvvStructure)) {
    if (
      String(o.field_name ?? "").toUpperCase() === "ZZ_VLAGER" ||
      includesNeedle(o, "ZZ_VLAGER")
    ) {
      structureFieldDef = true;
      vlager.ddic_hits.unshift({
        source: "master-data/customers/KNVV/structure.jsonl",
        preview: JSON.stringify({
          table_name: o.table_name,
          field_name: o.field_name,
          data_element: o.data_element,
          domain: o.domain,
          description: o.description,
        }),
      });
      break;
    }
  }
  vlager.ddic_missing = !structureFieldDef;

  vlager.field_hits = vlager.field_hits.slice(0, 30);
  vlager.code_read = vlager.code_read.slice(0, 30);
  vlager.code_write = vlager.code_write.slice(0, 30);
  vlager.control_tables = vlager.control_tables.slice(0, 40);
  vlager.repo_reads = vlager.repo_reads.slice(0, 20);
  vlager.repo_writes = vlager.repo_writes.slice(0, 20);
  vlager.ddic_hits = vlager.ddic_hits.slice(0, 10);

  // Assertions (soft report + exit code)
  const failures: string[] = [];
  if (zecd.authoritative_output_types.length === 0) {
    failures.push("A: ZECD authoritative OUTPUT_TYPE missing");
  }
  if (zecd.false_output_types.length > 0) {
    failures.push("A: ZECD non-authoritative output_type rows present");
  }
  const zecdProg = zecd.msg_relations.some(
    (r) =>
      r.relation_type === "PROCESSED_BY_PROGRAM" &&
      String(r.to_name).includes("ZECD"),
  );
  const zecdRout = zecd.msg_relations.some(
    (r) => r.relation_type === "PROCESSED_BY_ROUTINE",
  );
  if (!zecdProg) failures.push("A: ZECD PROCESSED_BY_PROGRAM missing");
  if (!zecdRout) failures.push("A: ZECD PROCESSED_BY_ROUTINE missing");

  if (zrah.output_type_objects.some((o) => o.authoritative === true)) {
    failures.push("B: ZRAH classified as authoritative OUTPUT_TYPE");
  }
  if (zrah.output_type_objects.length > 0) {
    failures.push("B: ZRAH still present as output_type object");
  }
  const hasRvadin = zrah.code_hits.some((h) => h.has_Z_RVADIN01);
  const hasGet = zrah.code_hits.some((h) => h.has_GET_ZRAH_PRICE);
  if (!hasRvadin && !zrah.repo_hits.some((h) => includesNeedle(h, "Z_RVADIN01"))) {
    failures.push("B: Z_RVADIN01 not found in code/repo");
  }
  if (!hasGet && !zrah.repo_hits.some((h) => includesNeedle(h, "GET_ZRAH_PRICE"))) {
    failures.push("B: GET_ZRAH_PRICE not found in code/repo");
  }
  if (!zrah.pricing_config_open && zrah.pricing_config_found === false) {
    failures.push("B: pricing_config flag inconsistent");
  }

  if (vlager.field_hits.length === 0 && vlager.code_read.length === 0) {
    failures.push("C: no ZZ_VLAGER field/code hits");
  }

  const report = {
    ok: failures.length === 0,
    failures,
    joint_profile: {
      message_idoc_11_stats: joint.message_idoc_11?.stats ?? null,
      repository_relations_stats: joint.repository_relations?.stats ?? null,
      files: joint.files,
    },
    A_ZECD: {
      authoritative_output_types: zecd.authoritative_output_types,
      program_routine_chain: zecd.msg_relations.filter((r) =>
        ["PROCESSED_BY_PROGRAM", "PROCESSED_BY_ROUTINE", "USES_FORM"].includes(
          String(r.relation_type),
        ),
      ),
      repo_usages: {
        resolved: zecd.repo_relations.slice(0, 30),
        unresolved: zecd.repo_unresolved.slice(0, 20),
      },
      idoc_partner_only_if_present: zecd.idoc_partner_relations,
      prior_group_relations_sample: zecd.prior_relations.slice(0, 10),
    },
    B_ZRAH: {
      must_not_be_output_type: zrah.output_type_objects.length === 0,
      output_type_objects: zrah.output_type_objects,
      msg_relations_as_output: zrah.msg_relations_as_output,
      code_hits: zrah.code_hits,
      repo_hits: zrah.repo_hits,
      pricing_configuration: {
        found: zrah.pricing_config_found,
        open: zrah.pricing_config_open,
        note: zrah.pricing_config_open
          ? "Keine Pricing-Konfiguration in control-tables/message-idoc Objekten gefunden — offen markiert"
          : "Pricing-bezogene Treffer vorhanden (nicht als OUTPUT_TYPE)",
      },
    },
    C_ZZ_VLAGER: {
      field_symbol_hits: vlager.field_hits,
      code_read: vlager.code_read,
      code_write: vlager.code_write,
      control_tables: vlager.control_tables,
      repo_reads: vlager.repo_reads,
      repo_writes: vlager.repo_writes,
      ddic_missing: vlager.ddic_missing,
      ddic_hits: vlager.ddic_hits,
      ddic_note: vlager.ddic_missing
        ? "Kein klares DDIC-/Strukturartefakt für KNVV-ZZ_VLAGER in geprüften Canonical-Pfaden"
        : "DDIC-/Feldtreffer vorhanden",
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
