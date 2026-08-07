/**
 * Deterministic DDIC request file for SAP upload mode.
 * No OpenAI — only evidenced tables/fields/structures from canonical artifacts.
 */

import { createHash } from "crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { createInterface } from "readline";
import { finished } from "stream/promises";
import { createWriteStream } from "fs";
import type { WriteStream } from "fs";

export const DDIC_REQUEST_REL = "DDIC_REQUEST.jsonl" as const;

/** Forced regression anchors — always included when deterministically known. */
export const DDIC_REGRESSION_ANCHORS = [
  { object_type: "TABL", object_name: "KNVV", priority: 1 },
  { object_type: "TABL-FIELD", object_name: "KNVV-ZZ_VLAGER", priority: 1 },
  { object_type: "TABL", object_name: "ZZTVAG", priority: 1 },
  { object_type: "TABL", object_name: "ZZTVAG_S", priority: 1 },
  { object_type: "TABL", object_name: "ZVLAGER_AUART", priority: 1 },
] as const;

const NOISE_TABLES = new Set([
  "SCREEN",
  "TABLE",
  "YEAR",
  "SPACE",
  "SYST",
  "SY",
  "DATA",
  "TYPE",
  "TYPES",
  "STRUCTURE",
  "INCLUDE",
  "METHOD",
  "CLASS",
  "FORM",
  "LINES",
  "ITAB",
  "ITABX",
]);

function isPlausibleAbapName(name: string): boolean {
  const n = name.trim().toUpperCase();
  if (n.length < 2 || n.length > 40) return false;
  if (NOISE_TABLES.has(n)) return false;
  // SAP object name: letters, digits, _, /, starts with letter or /
  if (!/^[A-Z/][A-Z0-9_/]*$/.test(n)) return false;
  // Reject snippet-like
  if (n.includes("(") || n.includes(" ") || n.includes("=")) return false;
  return true;
}

function isClassLikeName(name: string): boolean {
  const n = name.toUpperCase();
  return (
    n.startsWith("ZCL_") ||
    n.startsWith("CL_") ||
    n.startsWith("ZIF_") ||
    n.startsWith("IF_") ||
    n.startsWith("ZCX_")
  );
}

async function* streamJsonl(
  abs: string,
): AsyncGenerator<Record<string, unknown>> {
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

type AccObj = {
  object_type: string;
  object_name: string;
  reasons: Set<string>;
  sources: Set<string>;
  priority: number;
  requires_validation: boolean;
  evidence_class: "deterministic" | "requires_validation";
};

function keyOf(object_type: string, object_name: string): string {
  return `${object_type}\u0001${object_name.toUpperCase()}`;
}

function upsert(
  map: Map<string, AccObj>,
  params: {
    object_type: string;
    object_name: string;
    reason: string;
    source: string;
    priority: number;
    requires_validation?: boolean;
  },
): void {
  const name = params.object_name.trim().toUpperCase();
  if (!name) return;
  const k = keyOf(params.object_type, name);
  let acc = map.get(k);
  if (!acc) {
    acc = {
      object_type: params.object_type,
      object_name: name,
      reasons: new Set(),
      sources: new Set(),
      priority: params.priority,
      requires_validation: Boolean(params.requires_validation),
      evidence_class: params.requires_validation
        ? "requires_validation"
        : "deterministic",
    };
    map.set(k, acc);
  }
  acc.reasons.add(params.reason);
  acc.sources.add(params.source);
  acc.priority = Math.min(acc.priority, params.priority);
  if (params.requires_validation) {
    acc.requires_validation = true;
    acc.evidence_class = "requires_validation";
  }
}

export type BuildDdicRequestResult = {
  ok: boolean;
  absolutePath: string;
  errors: string[];
  stats: {
    deterministic_objects: number;
    requires_validation_objects: number;
    by_type: Record<string, number>;
    regression_anchors_present: string[];
  };
};

export async function buildDdicRequest(params: {
  absoluteCanonicalRoot: string;
  absoluteRequestsDir: string;
  systemId?: string;
}): Promise<BuildDdicRequestResult> {
  const errors: string[] = [];
  const root = params.absoluteCanonicalRoot;
  const reqDir = params.absoluteRequestsDir;
  mkdirSync(reqDir, { recursive: true });

  const confirmed = new Map<string, AccObj>();
  const validation = new Map<string, AccObj>();
  const knownControlTables = new Set<string>();
  const knownMasterTables = new Set<string>();

  const addDet = (
    object_type: string,
    object_name: string,
    reason: string,
    source: string,
    priority: number,
  ) =>
    upsert(confirmed, {
      object_type,
      object_name,
      reason,
      source,
      priority,
      requires_validation: false,
    });

  const addVal = (
    object_type: string,
    object_name: string,
    reason: string,
    source: string,
    priority: number,
  ) =>
    upsert(validation, {
      object_type,
      object_name,
      reason,
      source,
      priority,
      requires_validation: true,
    });

  // --- control-tables definitions (Z/Y + all) ---
  {
    const file = "control-tables/table_definitions.jsonl";
    const abs = path.join(root, file);
    for await (const o of streamJsonl(abs)) {
      const tn = String(o.table_name ?? "").toUpperCase();
      if (!isPlausibleAbapName(tn)) continue;
      knownControlTables.add(tn);
      addDet(
        "TABL",
        tn,
        "control-tables/table_definitions",
        file,
        tn.startsWith("Z") || tn.startsWith("Y") ? 2 : 3,
      );
      const fields = o.fields;
      if (Array.isArray(fields)) {
        for (const f of fields) {
          const fn =
            typeof f === "string"
              ? f
              : String((f as Record<string, unknown>)?.field_name ?? "");
          if (!fn || !isPlausibleAbapName(fn)) continue;
          addDet(
            "TABL-FIELD",
            `${tn}-${fn.toUpperCase()}`,
            "control-tables field definition",
            file,
            3,
          );
        }
      }
      for (const kf of (o.key_fields as unknown[]) ?? []) {
        const fn = String(kf ?? "").toUpperCase();
        if (!isPlausibleAbapName(fn)) continue;
        addDet(
          "TABL-FIELD",
          `${tn}-${fn}`,
          "control-tables key_field",
          file,
          3,
        );
      }
    }
  }

  // --- master-data structure fields ---
  for (const domain of ["customers", "vendors", "materials"] as const) {
    const domainDir = path.join(root, "master-data", domain);
    if (!existsSync(domainDir)) continue;
    const { readdirSync } = await import("fs");
    for (const ent of readdirSync(domainDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const table = ent.name.toUpperCase();
      if (!isPlausibleAbapName(table)) continue;
      knownMasterTables.add(table);
      addDet("TABL", table, `master-data/${domain} table folder`, `master-data/${domain}/${table}`, 2);
      const struct = path.join(domainDir, ent.name, "structure.jsonl");
      for await (const o of streamJsonl(struct)) {
        const fn = String(o.field_name ?? "").toUpperCase();
        if (!fn || !isPlausibleAbapName(fn)) continue;
        const de = String(o.data_element ?? "").toUpperCase();
        addDet(
          "TABL-FIELD",
          `${table}-${fn}`,
          "master-data structure field",
          `master-data/${domain}/${ent.name}/structure.jsonl`,
          fn.startsWith("ZZ_") || fn.startsWith("ZY_") ? 1 : 3,
        );
        if (de && isPlausibleAbapName(de) && de !== fn) {
          addDet(
            "DTEL",
            de,
            `data_element for ${table}-${fn}`,
            `master-data/${domain}/${ent.name}/structure.jsonl`,
            3,
          );
        }
      }
    }
  }

  // --- repository relations READS/WRITES ---
  {
    const file = "repository-relations/relations.jsonl";
    const abs = path.join(root, file);
    for await (const o of streamJsonl(abs)) {
      const rt = String(o.relation_type ?? "");
      const toType = String(o.to_type ?? "");
      const toName = String(o.to_name ?? "").toUpperCase();
      if (
        (rt === "READS_TABLE" || rt === "WRITES_TABLE") &&
        toType === "TABLE"
      ) {
        if (!isPlausibleAbapName(toName)) continue;
        if (isClassLikeName(toName) && !knownControlTables.has(toName)) {
          addVal(
            "TABL",
            toName,
            `${rt} but class-like name without control-table proof`,
            file,
            4,
          );
          continue;
        }
        addDet(
          "TABL",
          toName,
          `${rt} from repository-relations`,
          file,
          rt === "WRITES_TABLE" ? 2 : 3,
        );
      }
      // explicit TABLE-FIELD symbols
      if (
        (toType === "TABLE" || toType === "FIELD") &&
        /^[A-Z/][A-Z0-9_/]*-[A-Z/][A-Z0-9_/]*$/.test(toName)
      ) {
        const [tab, field] = toName.split("-");
        if (
          tab &&
          field &&
          isPlausibleAbapName(tab) &&
          isPlausibleAbapName(field)
        ) {
          addDet("TABL", tab, "table from TABLE-FIELD symbol", file, 3);
          addDet("TABL-FIELD", toName, "explicit TABLE-FIELD symbol", file, 2);
        }
      }
    }
  }

  // --- knowledge graph TABLE nodes ---
  {
    const file = "knowledge-graph/nodes.jsonl";
    const abs = path.join(root, file);
    for await (const o of streamJsonl(abs)) {
      if (String(o.object_type) !== "TABLE") continue;
      const name = String(o.name ?? o.identity_key ?? "").toUpperCase();
      if (!isPlausibleAbapName(name)) continue;
      if (isClassLikeName(name) && !knownControlTables.has(name)) {
        addVal("TABL", name, "KG TABLE node class-like", file, 4);
        continue;
      }
      addDet("TABL", name, "knowledge-graph TABLE node", file, 3);
    }
  }

  // --- programs / FM extracts ---
  for (const domain of ["programs", "function-modules"] as const) {
    const file = `${domain}/extracts.jsonl`;
    const abs = path.join(root, file);
    for await (const o of streamJsonl(abs)) {
      for (const t of (o.tables_read as unknown[]) ?? []) {
        const tn = String(t ?? "").toUpperCase();
        if (!isPlausibleAbapName(tn)) continue;
        if (isClassLikeName(tn) && !knownControlTables.has(tn)) {
          addVal("TABL", tn, `${domain} extract tables_read class-like`, file, 4);
          continue;
        }
        addDet("TABL", tn, `${domain} extract tables_read`, file, 3);
      }
      for (const t of (o.tables_written as unknown[]) ?? []) {
        const tn = String(t ?? "").toUpperCase();
        if (!isPlausibleAbapName(tn)) continue;
        if (isClassLikeName(tn) && !knownControlTables.has(tn)) {
          addVal(
            "TABL",
            tn,
            `${domain} extract tables_written class-like`,
            file,
            4,
          );
          continue;
        }
        addDet("TABL", tn, `${domain} extract tables_written`, file, 2);
      }
      for (const f of (o.fields as unknown[]) ?? []) {
        const raw = String(f ?? "").toUpperCase();
        if (!/^[A-Z/][A-Z0-9_/]*-[A-Z/][A-Z0-9_/]*$/.test(raw)) continue;
        const [tab, field] = raw.split("-");
        if (!tab || !field) continue;
        if (!isPlausibleAbapName(tab) || !isPlausibleAbapName(field)) continue;
        // SY-* / screen noise
        if (tab === "SY" || tab === "SYST" || tab.startsWith("SCREEN")) {
          addVal("TABL-FIELD", raw, `${domain} extract field noise`, file, 5);
          continue;
        }
        addDet("TABL", tab, `${domain} extract field table`, file, 3);
        addDet("TABL-FIELD", raw, `${domain} extract field`, file, 3);
      }
    }
  }

  // --- message-idoc: no DDIC tables usually; skip unless attributes mention ---

  // --- regression anchors (deterministic override) ---
  const regressionPresent: string[] = [];
  for (const a of DDIC_REGRESSION_ANCHORS) {
    // Prefer confirmed if already present; else force deterministic with regression reason
    const k = keyOf(a.object_type, a.object_name);
    if (!confirmed.has(k)) {
      // ZZTVAG_S / ZVLAGER_AUART may only be in control or repo — still force
      addDet(
        a.object_type,
        a.object_name,
        "regression anchor (KNVV/ZZ_VLAGER/ZZTVAG)",
        "regression",
        a.priority,
      );
    } else {
      confirmed.get(k)!.reasons.add("regression anchor");
      confirmed.get(k)!.priority = Math.min(
        confirmed.get(k)!.priority,
        a.priority,
      );
    }
    // Remove from validation if present
    validation.delete(k);
    regressionPresent.push(`${a.object_type}:${a.object_name}`);
  }

  // Do not promote validation entries that collide with confirmed
  for (const k of confirmed.keys()) validation.delete(k);

  const staging = path.join(reqDir, `.tmp-ddic-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  const stagingFile = path.join(staging, DDIC_REQUEST_REL);
  const finalFile = path.join(reqDir, DDIC_REQUEST_REL);

  const byType: Record<string, number> = {};
  try {
    const ws: WriteStream = createWriteStream(stagingFile, { flags: "w" });
    const header = {
      schema_version: "1.0",
      record_type: "header",
      export_type: "DDIC_REQUEST",
      system_id: params.systemId ?? "Q01",
      generated_at: new Date().toISOString(),
      object_count: confirmed.size + validation.size,
      deterministic_count: confirmed.size,
      requires_validation_count: validation.size,
      notes: [
        "Deterministic DDIC request for SAP upload mode",
        "No OpenAI",
        "requires_validation = unclear/symbol suggestions — do not auto-upload without review",
      ],
    };
    ws.write(`${JSON.stringify(header)}\n`);

    const rows = [
      ...[...confirmed.values()].map((o) => ({ ...o, requires_validation: false })),
      ...[...validation.values()].map((o) => ({ ...o, requires_validation: true })),
    ].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const c = a.object_type.localeCompare(b.object_type, "en");
      if (c !== 0) return c;
      return a.object_name.localeCompare(b.object_name, "en");
    });

    for (const o of rows) {
      byType[o.object_type] = (byType[o.object_type] ?? 0) + 1;
      const out = {
        schema_version: "1.0",
        record_type: "object",
        object_type: o.object_type,
        object_name: o.object_name,
        reason: [...o.reasons].sort().join("; "),
        priority: o.priority,
        requires_validation: o.requires_validation,
        evidence_class: o.requires_validation
          ? "requires_validation"
          : "deterministic",
        sources: [...o.sources].sort(),
        _request_key: createHash("sha1")
          .update(`${o.object_type}|${o.object_name}`)
          .digest("hex")
          .slice(0, 24),
      };
      if (!ws.write(`${JSON.stringify(out)}\n`)) {
        await new Promise<void>((r) => ws.once("drain", r));
      }
    }
    ws.end();
    await finished(ws);

    if (existsSync(finalFile)) rmSync(finalFile, { force: true });
    renameSync(stagingFile, finalFile);

    return {
      ok: true,
      absolutePath: finalFile,
      errors,
      stats: {
        deterministic_objects: confirmed.size,
        requires_validation_objects: validation.size,
        by_type: byType,
        regression_anchors_present: regressionPresent,
      },
    };
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      absolutePath: finalFile,
      errors,
      stats: {
        deterministic_objects: 0,
        requires_validation_objects: 0,
        by_type: {},
        regression_anchors_present: [],
      },
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
