/**
 * Pass: MESSAGE_IDOC_11_RELATIONS → canonical/message-idoc-config/relations.jsonl
 *
 * - Streaming, edge-dedupe, occurrence_count + context aggregation
 * - Does not modify objects.jsonl / object_ids / unmapped / header / ingest_report
 * - Write-once gated by relations-manifest.json
 * - Existing derived relations.jsonl (groups 01–10) preserved as
 *   relations.from-groups-01-10.jsonl before replace
 */

import { createHash } from "crypto";
import {
  createReadStream,
  createWriteStream,
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
import type { WriteStream } from "fs";
import {
  MESSAGE_IDOC_11_RELATIONS_GROUP,
  MESSAGE_IDOC_11_RELATIONS_PATTERN,
} from "@/lib/admin/datenbasis/messageIdocConfig/resolveRelations11";

export const MESSAGE_IDOC_11_CANONICAL_DIR = "message-idoc-config" as const;
export const MESSAGE_IDOC_11_RELATIONS_OUT = "relations.jsonl" as const;
export const MESSAGE_IDOC_11_MANIFEST_OUT = "relations-manifest.json" as const;
export const MESSAGE_IDOC_11_PRESERVED_RELATIONS =
  "relations.from-groups-01-10.jsonl" as const;

export type MessageIdoc11RelationContexts = {
  raw_metadata: string[];
  source_tables: string[];
  partner_types: string[];
  directions: string[];
  partner_profiles: string[];
  programs: string[];
  routines: string[];
  forms: string[];
  applications: string[];
  other_meta: Record<string, string[]>;
};

export type MessageIdoc11Stats = {
  lines_total: number;
  blank_lines: number;
  parse_errors: number;
  headers: number;
  relations_raw: number;
  relations_unique: number;
  relations_dup_extra: number;
  edges_with_multi_context: number;
  context_entries_total: number;
  relation_types: Record<string, number>;
  from_types: Record<string, number>;
  to_types: Record<string, number>;
  source_tables: Record<string, number>;
  partner_types: Record<string, number>;
  directions: Record<string, number>;
  authoritative_true: number;
  usage_relation_true: number;
};

export type MessageIdoc11RelationsManifest = {
  schema_version: string;
  pass: "message_idoc_11_relations";
  ok: boolean;
  converted_at: string;
  source: {
    file_name: string;
    relative_path: string;
    file_sha256: string;
    bytes: number;
    pattern: string;
    group: string;
    system_id: string | null;
    export_type: string | null;
    schema_version: string | null;
    header_relation_count: number | null;
  };
  outputs: {
    relations: string;
    manifest: string;
    preserved_prior_relations: string | null;
  };
  stats: MessageIdoc11Stats;
  notes: string[];
};

type EdgeKeyParts = {
  from_type: string;
  from_name: string;
  relation_type: string;
  to_type: string;
  to_name: string;
};

type Acc = EdgeKeyParts & {
  occurrence_count: number;
  system_id: string;
  schema_version: string;
  raw_metadata: Set<string>;
  source_tables: Set<string>;
  partner_types: Set<string>;
  directions: Set<string>;
  partner_profiles: Set<string>;
  programs: Set<string>;
  routines: Set<string>;
  forms: Set<string>;
  applications: Set<string>;
  other_meta: Map<string, Set<string>>;
  authoritative: boolean;
  usage_relation: boolean;
};

function edgeKey(e: EdgeKeyParts): string {
  return [
    e.from_type,
    e.from_name,
    e.relation_type,
    e.to_type,
    e.to_name,
  ].join("\u0001");
}

function bump(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

function emptyStats(): MessageIdoc11Stats {
  return {
    lines_total: 0,
    blank_lines: 0,
    parse_errors: 0,
    headers: 0,
    relations_raw: 0,
    relations_unique: 0,
    relations_dup_extra: 0,
    edges_with_multi_context: 0,
    context_entries_total: 0,
    relation_types: {},
    from_types: {},
    to_types: {},
    source_tables: {},
    partner_types: {},
    directions: {},
    authoritative_true: 0,
    usage_relation_true: 0,
  };
}

async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(absolutePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function parseMetadata(meta: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of meta.split(";")) {
    const t = part.trim();
    if (!t || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function applicationFromOutputName(fromType: string, fromName: string): string | null {
  if (fromType !== "OUTPUT_TYPE") return null;
  const parts = fromName.split("|");
  return parts.length >= 2 ? parts[0]!.trim() || null : null;
}

function addToSetMap(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

export type ConvertMessageIdoc11Params = {
  absoluteRawPath: string;
  absoluteCanonicalDir: string;
  sourceFileName: string;
  sourceRelativePath: string;
  overwrite?: boolean;
};

export type ConvertMessageIdoc11Result = {
  ok: boolean;
  manifest: MessageIdoc11RelationsManifest;
  errors: string[];
};

export async function convertMessageIdoc11Relations(
  params: ConvertMessageIdoc11Params,
): Promise<ConvertMessageIdoc11Result> {
  const errors: string[] = [];
  const {
    absoluteRawPath,
    absoluteCanonicalDir,
    sourceFileName,
    sourceRelativePath,
    overwrite = false,
  } = params;

  if (!existsSync(absoluteRawPath) || !statSync(absoluteRawPath).isFile()) {
    return {
      ok: false,
      errors: [`RAW-Datei fehlt: ${absoluteRawPath}`],
      manifest: stubManifest(params, emptyStats(), false),
    };
  }

  mkdirSync(absoluteCanonicalDir, { recursive: true });

  const relationsOut = path.join(
    absoluteCanonicalDir,
    MESSAGE_IDOC_11_RELATIONS_OUT,
  );
  const manifestOut = path.join(
    absoluteCanonicalDir,
    MESSAGE_IDOC_11_MANIFEST_OUT,
  );
  const preservedOut = path.join(
    absoluteCanonicalDir,
    MESSAGE_IDOC_11_PRESERVED_RELATIONS,
  );

  if (!overwrite && existsSync(manifestOut)) {
    return {
      ok: false,
      errors: [
        `Write-once verweigert — ${MESSAGE_IDOC_11_MANIFEST_OUT} existiert bereits`,
      ],
      manifest: stubManifest(params, emptyStats(), false),
    };
  }

  // Never touch these
  const protectedFiles = [
    "objects.jsonl",
    "object_ids.jsonl",
    "unmapped.jsonl",
    "header.json",
    "ingest_report.json",
  ];
  const protectedSnapshot = protectedFiles.map((name) => {
    const abs = path.join(absoluteCanonicalDir, name);
    return {
      name,
      abs,
      mtime: existsSync(abs) ? statSync(abs).mtimeMs : null,
      size: existsSync(abs) ? statSync(abs).size : null,
    };
  });

  const fileSha = await sha256File(absoluteRawPath);
  const bytes = statSync(absoluteRawPath).size;
  const stats = emptyStats();
  const edges = new Map<string, Acc>();

  let headerSystemId: string | null = null;
  let headerExportType: string | null = null;
  let headerSchema: string | null = null;
  let headerRelationCount: number | null = null;

  const rl = createInterface({
    input: createReadStream(absoluteRawPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      stats.lines_total += 1;
      const trimmed = line.trim();
      if (!trimmed) {
        stats.blank_lines += 1;
        continue;
      }
      let obj: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          stats.parse_errors += 1;
          continue;
        }
        obj = parsed as Record<string, unknown>;
      } catch {
        stats.parse_errors += 1;
        continue;
      }

      const recordType = String(obj.record_type ?? "");
      if (recordType === "header") {
        stats.headers += 1;
        headerSystemId =
          typeof obj.system_id === "string" ? obj.system_id : headerSystemId;
        headerExportType =
          typeof obj.export_type === "string"
            ? obj.export_type
            : headerExportType;
        headerSchema =
          typeof obj.schema_version === "string"
            ? obj.schema_version
            : headerSchema;
        if (typeof obj.relation_count === "number") {
          headerRelationCount = obj.relation_count;
        }
        continue;
      }

      if (recordType !== "relation") {
        stats.parse_errors += 1;
        continue;
      }

      const from_type = String(obj.from_type ?? "").trim();
      const from_name = String(obj.from_name ?? "").trim();
      const relation_type = String(obj.relation_type ?? "").trim();
      const to_type = String(obj.to_type ?? "").trim();
      const to_name = String(obj.to_name ?? "").trim();
      const metadata =
        typeof obj.metadata === "string" ? obj.metadata.trim() : "";
      const system_id = String(obj.system_id ?? headerSystemId ?? "");
      const schema_version = String(obj.schema_version ?? headerSchema ?? "");

      if (!from_type || !relation_type || !to_type) {
        stats.parse_errors += 1;
        continue;
      }

      stats.relations_raw += 1;
      bump(stats.relation_types, relation_type);
      bump(stats.from_types, from_type);
      bump(stats.to_types, to_type);

      const meta = parseMetadata(metadata);
      const sourceTable = meta.source ?? "";
      if (sourceTable) bump(stats.source_tables, sourceTable);
      if (meta.partner_type) bump(stats.partner_types, meta.partner_type);
      if (meta.direction) bump(stats.directions, meta.direction);
      if (meta.authoritative === "true") stats.authoritative_true += 1;
      if (meta.usage_relation === "true") stats.usage_relation_true += 1;

      const key = edgeKey({
        from_type,
        from_name,
        relation_type,
        to_type,
        to_name,
      });
      let acc = edges.get(key);
      if (!acc) {
        acc = {
          from_type,
          from_name,
          relation_type,
          to_type,
          to_name,
          occurrence_count: 0,
          system_id,
          schema_version,
          raw_metadata: new Set(),
          source_tables: new Set(),
          partner_types: new Set(),
          directions: new Set(),
          partner_profiles: new Set(),
          programs: new Set(),
          routines: new Set(),
          forms: new Set(),
          applications: new Set(),
          other_meta: new Map(),
          authoritative: false,
          usage_relation: false,
        };
        edges.set(key, acc);
      } else {
        stats.relations_dup_extra += 1;
      }

      acc.occurrence_count += 1;
      if (metadata) acc.raw_metadata.add(metadata);
      if (sourceTable) acc.source_tables.add(sourceTable);
      if (meta.partner_type) acc.partner_types.add(meta.partner_type);
      if (meta.direction) acc.directions.add(meta.direction);
      if (meta.authoritative === "true") acc.authoritative = true;
      if (meta.usage_relation === "true") acc.usage_relation = true;

      if (from_type === "PARTNER_PROFILE" && from_name) {
        acc.partner_profiles.add(from_name);
      }
      if (to_type === "PROGRAM" && to_name) acc.programs.add(to_name);
      if (to_type === "FORM_ROUTINE" && to_name) acc.routines.add(to_name);
      if (to_type === "FORM" && to_name) acc.forms.add(to_name);
      const app = applicationFromOutputName(from_type, from_name);
      if (app) acc.applications.add(app);

      for (const [k, v] of Object.entries(meta)) {
        if (
          k === "source" ||
          k === "partner_type" ||
          k === "direction" ||
          k === "authoritative" ||
          k === "usage_relation"
        ) {
          continue;
        }
        addToSetMap(acc.other_meta, k, v);
      }
    }
  } finally {
    rl.close();
  }

  stats.relations_unique = edges.size;
  for (const acc of edges.values()) {
    const ctxCount =
      acc.raw_metadata.size +
      acc.partner_types.size +
      acc.directions.size +
      acc.partner_profiles.size;
    stats.context_entries_total +=
      acc.raw_metadata.size +
      acc.source_tables.size +
      acc.partner_types.size +
      acc.directions.size +
      acc.partner_profiles.size +
      acc.programs.size +
      acc.routines.size +
      acc.forms.size +
      acc.applications.size;
    if (acc.raw_metadata.size > 1 || ctxCount > 2) {
      stats.edges_with_multi_context += 1;
    }
  }

  const staging = path.join(
    absoluteCanonicalDir,
    `.tmp-msgidoc11-${process.pid}-${Date.now()}`,
  );
  mkdirSync(staging, { recursive: true });
  const stagingRelations = path.join(staging, MESSAGE_IDOC_11_RELATIONS_OUT);
  const stagingManifest = path.join(staging, MESSAGE_IDOC_11_MANIFEST_OUT);

  let preservedPrior: string | null = null;

  try {
    await writeRelationsJsonl(
      stagingRelations,
      edges,
      fileSha,
      sourceFileName,
    );

    // Preserve prior derived relations (groups 01–10) without touching objects
    if (
      existsSync(relationsOut) &&
      !existsSync(preservedOut) &&
      !overwrite
    ) {
      renameSync(relationsOut, preservedOut);
      preservedPrior = `canonical/${MESSAGE_IDOC_11_CANONICAL_DIR}/${MESSAGE_IDOC_11_PRESERVED_RELATIONS}`;
    } else if (existsSync(preservedOut)) {
      preservedPrior = `canonical/${MESSAGE_IDOC_11_CANONICAL_DIR}/${MESSAGE_IDOC_11_PRESERVED_RELATIONS}`;
    }

    const manifest: MessageIdoc11RelationsManifest = {
      schema_version: "1.0",
      pass: "message_idoc_11_relations",
      ok: errors.length === 0 && stats.parse_errors === 0,
      converted_at: new Date().toISOString(),
      source: {
        file_name: sourceFileName,
        relative_path: sourceRelativePath,
        file_sha256: fileSha,
        bytes,
        pattern: MESSAGE_IDOC_11_RELATIONS_PATTERN,
        group: MESSAGE_IDOC_11_RELATIONS_GROUP,
        system_id: headerSystemId,
        export_type: headerExportType,
        schema_version: headerSchema,
        header_relation_count: headerRelationCount,
      },
      outputs: {
        relations: `canonical/${MESSAGE_IDOC_11_CANONICAL_DIR}/${MESSAGE_IDOC_11_RELATIONS_OUT}`,
        manifest: `canonical/${MESSAGE_IDOC_11_CANONICAL_DIR}/${MESSAGE_IDOC_11_MANIFEST_OUT}`,
        preserved_prior_relations: preservedPrior,
      },
      stats,
      notes: [
        "Streaming Pass für MESSAGE_IDOC_11_RELATIONS",
        "Dedupe: from_type|from_name|relation_type|to_type|to_name",
        "contexts aggregieren Partner/Direction/Source/Programme/Routinen",
        "objects.jsonl und weitere Canonical-Objekte unverändert",
        "Kein OpenAI, kein Index-Rebuild",
      ],
    };

    writeFileSync(
      stagingManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    if (overwrite && existsSync(relationsOut)) rmSync(relationsOut, { force: true });
    if (overwrite && existsSync(manifestOut)) rmSync(manifestOut, { force: true });

    renameSync(stagingRelations, relationsOut);
    renameSync(stagingManifest, manifestOut);

    // Assert protected files untouched
    for (const p of protectedSnapshot) {
      const mtime = existsSync(p.abs) ? statSync(p.abs).mtimeMs : null;
      const size = existsSync(p.abs) ? statSync(p.abs).size : null;
      if (p.mtime !== mtime || p.size !== size) {
        errors.push(`PROTECTED TOUCHED: ${p.name}`);
      }
    }

    manifest.ok = manifest.ok && errors.length === 0;
    if (errors.length) {
      writeFileSync(
        manifestOut,
        `${JSON.stringify({ ...manifest, ok: false, errors }, null, 2)}\n`,
        "utf8",
      );
    }

    return { ok: manifest.ok, manifest, errors };
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      errors,
      manifest: stubManifest(params, stats, false, {
        file_sha256: fileSha,
        bytes,
        system_id: headerSystemId,
        export_type: headerExportType,
        schema_version: headerSchema,
        header_relation_count: headerRelationCount,
      }),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function writeRelationsJsonl(
  absolutePath: string,
  edges: Map<string, Acc>,
  fileSha: string,
  sourceFileName: string,
): Promise<void> {
  const rows = [...edges.values()].sort((a, b) =>
    edgeKey(a).localeCompare(edgeKey(b), "en"),
  );
  const ws: WriteStream = createWriteStream(absolutePath, { flags: "w" });
  for (const r of rows) {
    const source_tables = [...r.source_tables].sort((a, b) =>
      a.localeCompare(b, "en"),
    );
    const contexts: MessageIdoc11RelationContexts = {
      raw_metadata: [...r.raw_metadata].sort((a, b) => a.localeCompare(b, "en")),
      source_tables,
      partner_types: [...r.partner_types].sort((a, b) => a.localeCompare(b, "en")),
      directions: [...r.directions].sort((a, b) => a.localeCompare(b, "en")),
      partner_profiles: [...r.partner_profiles].sort((a, b) =>
        a.localeCompare(b, "en"),
      ),
      programs: [...r.programs].sort((a, b) => a.localeCompare(b, "en")),
      routines: [...r.routines].sort((a, b) => a.localeCompare(b, "en")),
      forms: [...r.forms].sort((a, b) => a.localeCompare(b, "en")),
      applications: [...r.applications].sort((a, b) => a.localeCompare(b, "en")),
      other_meta: Object.fromEntries(
        [...r.other_meta.entries()]
          .sort((a, b) => a[0].localeCompare(b[0], "en"))
          .map(([k, set]) => [
            k,
            [...set].sort((a, b) => a.localeCompare(b, "en")),
          ]),
      ),
    };
    const canonicalKey = createHash("sha1")
      .update(edgeKey(r), "utf8")
      .digest("hex")
      .slice(0, 24);
    const out = {
      schema_version: "1.0",
      record_type: "relation",
      system_id: r.system_id,
      from_type: r.from_type,
      from_name: r.from_name,
      relation_type: r.relation_type,
      to_type: r.to_type,
      to_name: r.to_name,
      occurrence_count: r.occurrence_count,
      authoritative: r.authoritative,
      usage_relation: r.usage_relation,
      source_tables,
      primary_source_table: source_tables[0] ?? null,
      contexts,
      _canonical_key: canonicalKey,
      _raw_ref: {
        file_name: sourceFileName,
        file_sha256: fileSha,
        group: MESSAGE_IDOC_11_RELATIONS_GROUP,
        record_type: "relation",
      },
    };
    if (!ws.write(`${JSON.stringify(out)}\n`)) {
      await new Promise<void>((resolve) => ws.once("drain", resolve));
    }
  }
  ws.end();
  await finished(ws);
}

function stubManifest(
  params: ConvertMessageIdoc11Params,
  stats: MessageIdoc11Stats,
  ok: boolean,
  sourceExtra?: Partial<MessageIdoc11RelationsManifest["source"]>,
): MessageIdoc11RelationsManifest {
  return {
    schema_version: "1.0",
    pass: "message_idoc_11_relations",
    ok,
    converted_at: new Date().toISOString(),
    source: {
      file_name: params.sourceFileName,
      relative_path: params.sourceRelativePath,
      file_sha256: sourceExtra?.file_sha256 ?? "",
      bytes: sourceExtra?.bytes ?? 0,
      pattern: MESSAGE_IDOC_11_RELATIONS_PATTERN,
      group: MESSAGE_IDOC_11_RELATIONS_GROUP,
      system_id: sourceExtra?.system_id ?? null,
      export_type: sourceExtra?.export_type ?? null,
      schema_version: sourceExtra?.schema_version ?? null,
      header_relation_count: sourceExtra?.header_relation_count ?? null,
    },
    outputs: {
      relations: `canonical/${MESSAGE_IDOC_11_CANONICAL_DIR}/${MESSAGE_IDOC_11_RELATIONS_OUT}`,
      manifest: `canonical/${MESSAGE_IDOC_11_CANONICAL_DIR}/${MESSAGE_IDOC_11_MANIFEST_OUT}`,
      preserved_prior_relations: null,
    },
    stats,
    notes: ["stub / failed convert"],
  };
}
