/**
 * Pass-1: SAP_REPOSITORY_RELATIONS RAW → canonical/repository-relations/.
 *
 * - Streaming read
 * - Exact edge dedupe: from_type|from_name|relation_type|to_type|to_name
 * - occurrence_count + contexts (unique metadata / include hints)
 * - UNRESOLVED_* → unresolved.jsonl (not dropped)
 * - Write-once / atomic (staging dir + rename)
 * - No OpenAI, no index rebuild
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

export const REPOSITORY_RELATIONS_EXPORT_TYPE =
  "SAP_REPOSITORY_RELATIONS" as const;

export const REPOSITORY_RELATIONS_RAW_PARTS = [
  "repository-relations",
] as const;

export const REPOSITORY_RELATIONS_RAW_PATTERN =
  "*_SAP_REPOSITORY_RELATIONS_CONTENT.jsonl" as const;

export const REPOSITORY_RELATIONS_CANONICAL_DIR =
  "repository-relations" as const;

export const REPOSITORY_RELATIONS_OUTPUTS = [
  "objects.jsonl",
  "relations.jsonl",
  "unresolved.jsonl",
  "manifest.json",
] as const;

export type RepositoryRelationsStats = {
  lines_total: number;
  blank_lines: number;
  parse_errors: number;
  headers: number;
  source_objects_raw: number;
  source_objects_unique: number;
  source_object_dups: number;
  relations_raw: number;
  relations_unique: number;
  relations_dup_extra: number;
  unresolved_raw: number;
  unresolved_unique: number;
  unresolved_dup_extra: number;
  relation_types: Record<string, number>;
  object_types: Record<string, number>;
  from_types: Record<string, number>;
  to_types: Record<string, number>;
};

export type RepositoryRelationsManifest = {
  schema_version: string;
  pass: "pass1";
  ok: boolean;
  converted_at: string;
  source: {
    file_name: string;
    relative_path: string;
    file_sha256: string;
    bytes: number;
    system_id: string | null;
    export_type: string | null;
    schema_version: string | null;
    header_object_count: number | null;
    header_relation_count: number | null;
  };
  outputs: {
    objects: string;
    relations: string;
    unresolved: string;
    manifest: string;
  };
  stats: RepositoryRelationsStats;
  notes: string[];
};

export type RepositoryRelationEdge = {
  from_type: string;
  from_name: string;
  relation_type: string;
  to_type: string;
  to_name: string;
};

type AccRelation = RepositoryRelationEdge & {
  occurrence_count: number;
  contexts: Set<string>;
  system_id: string;
  schema_version: string;
};

function edgeKey(e: RepositoryRelationEdge): string {
  return [
    e.from_type,
    e.from_name,
    e.relation_type,
    e.to_type,
    e.to_name,
  ].join("\u0001");
}

function isUnresolved(relationType: string): boolean {
  return relationType.startsWith("UNRESOLVED_");
}

function bump(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(absolutePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function emptyStats(): RepositoryRelationsStats {
  return {
    lines_total: 0,
    blank_lines: 0,
    parse_errors: 0,
    headers: 0,
    source_objects_raw: 0,
    source_objects_unique: 0,
    source_object_dups: 0,
    relations_raw: 0,
    relations_unique: 0,
    relations_dup_extra: 0,
    unresolved_raw: 0,
    unresolved_unique: 0,
    unresolved_dup_extra: 0,
    relation_types: {},
    object_types: {},
    from_types: {},
    to_types: {},
  };
}

export type ConvertRepositoryRelationsParams = {
  absoluteRawPath: string;
  absoluteCanonicalDir: string;
  sourceFileName: string;
  sourceRelativePath: string;
  /** When false (default), refuse if outputs already exist. */
  overwrite?: boolean;
};

export type ConvertRepositoryRelationsResult = {
  ok: boolean;
  manifest: RepositoryRelationsManifest;
  errors: string[];
};

/**
 * Stream-convert RAW → staging → atomic rename into canonical dir.
 */
export async function convertRepositoryRelationsPass1(
  params: ConvertRepositoryRelationsParams,
): Promise<ConvertRepositoryRelationsResult> {
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

  const finalPaths = Object.fromEntries(
    REPOSITORY_RELATIONS_OUTPUTS.map((name) => [
      name,
      path.join(absoluteCanonicalDir, name),
    ]),
  ) as Record<(typeof REPOSITORY_RELATIONS_OUTPUTS)[number], string>;

  if (!overwrite) {
    const existing = REPOSITORY_RELATIONS_OUTPUTS.filter((n) =>
      existsSync(finalPaths[n]),
    );
    if (existing.length > 0) {
      return {
        ok: false,
        errors: [
          `Write-once verweigert — bereits vorhanden: ${existing.join(", ")}. Kein Überschreiben.`,
        ],
        manifest: stubManifest(params, emptyStats(), false),
      };
    }
  }

  const fileSha = await sha256File(absoluteRawPath);
  const bytes = statSync(absoluteRawPath).size;

  const stats = emptyStats();
  const objectsByKey = new Map<string, Record<string, unknown>>();
  const resolved = new Map<string, AccRelation>();
  const unresolved = new Map<string, AccRelation>();

  let headerSystemId: string | null = null;
  let headerExportType: string | null = null;
  let headerSchema: string | null = null;
  let headerObjectCount: number | null = null;
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
        if (typeof obj.object_count === "number") {
          headerObjectCount = obj.object_count;
        }
        if (typeof obj.relation_count === "number") {
          headerRelationCount = obj.relation_count;
        }
        if (
          headerExportType &&
          headerExportType !== REPOSITORY_RELATIONS_EXPORT_TYPE
        ) {
          errors.push(
            `header.export_type="${headerExportType}" — erwartet ${REPOSITORY_RELATIONS_EXPORT_TYPE}`,
          );
        }
        continue;
      }

      if (recordType === "source_object") {
        stats.source_objects_raw += 1;
        const sourceKey =
          typeof obj.source_key === "string" && obj.source_key.trim()
            ? obj.source_key.trim()
            : [
                String(obj.system_id ?? ""),
                String(obj.object_type ?? ""),
                String(obj.object_name ?? ""),
              ].join("|");
        const objectType = String(obj.object_type ?? "");
        bump(stats.object_types, objectType || "(empty)");
        if (objectsByKey.has(sourceKey)) {
          stats.source_object_dups += 1;
          continue;
        }
        objectsByKey.set(sourceKey, {
          schema_version: String(obj.schema_version ?? headerSchema ?? ""),
          record_type: "source_object",
          system_id: String(obj.system_id ?? headerSystemId ?? ""),
          source_key: sourceKey,
          object_type: objectType,
          object_name: String(obj.object_name ?? ""),
          description:
            typeof obj.description === "string" ? obj.description : "",
          main_program:
            typeof obj.main_program === "string" ? obj.main_program : "",
          active: Boolean(obj.active),
          _raw_ref: {
            file_name: sourceFileName,
            file_sha256: fileSha,
            record_type: "source_object",
          },
        });
        continue;
      }

      if (recordType === "relation") {
        const from_type = String(obj.from_type ?? "").trim();
        const from_name = String(obj.from_name ?? "").trim();
        const relation_type = String(obj.relation_type ?? "").trim();
        const to_type = String(obj.to_type ?? "").trim();
        const to_name = String(obj.to_name ?? "").trim();
        const metadata =
          typeof obj.metadata === "string" ? obj.metadata.trim() : "";
        const system_id = String(obj.system_id ?? headerSystemId ?? "");
        const schema_version = String(
          obj.schema_version ?? headerSchema ?? "",
        );

        if (!from_type || !relation_type || !to_type) {
          stats.parse_errors += 1;
          continue;
        }

        bump(stats.relation_types, relation_type);
        bump(stats.from_types, from_type);
        bump(stats.to_types, to_type);

        const edge: RepositoryRelationEdge = {
          from_type,
          from_name,
          relation_type,
          to_type,
          to_name,
        };
        const key = edgeKey(edge);
        const targetMap = isUnresolved(relation_type) ? unresolved : resolved;
        if (isUnresolved(relation_type)) {
          stats.unresolved_raw += 1;
        } else {
          stats.relations_raw += 1;
        }

        const existing = targetMap.get(key);
        if (existing) {
          existing.occurrence_count += 1;
          if (metadata) existing.contexts.add(metadata);
          if (isUnresolved(relation_type)) stats.unresolved_dup_extra += 1;
          else stats.relations_dup_extra += 1;
        } else {
          const contexts = new Set<string>();
          if (metadata) contexts.add(metadata);
          targetMap.set(key, {
            ...edge,
            occurrence_count: 1,
            contexts,
            system_id,
            schema_version,
          });
        }
        continue;
      }

      // unknown record_type — count but do not fail
      bump(stats.relation_types, `other:${recordType || "empty"}`);
    }
  } finally {
    rl.close();
  }

  stats.source_objects_unique = objectsByKey.size;
  stats.relations_unique = resolved.size;
  stats.unresolved_unique = unresolved.size;

  const staging = path.join(
    absoluteCanonicalDir,
    `.tmp-pass1-${process.pid}-${Date.now()}`,
  );
  mkdirSync(staging, { recursive: true });

  const stagingPaths: Record<(typeof REPOSITORY_RELATIONS_OUTPUTS)[number], string> = {
    "objects.jsonl": path.join(staging, "objects.jsonl"),
    "relations.jsonl": path.join(staging, "relations.jsonl"),
    "unresolved.jsonl": path.join(staging, "unresolved.jsonl"),
    "manifest.json": path.join(staging, "manifest.json"),
  };

  try {
    await writeJsonl(
      stagingPaths["objects.jsonl"],
      [...objectsByKey.values()].sort((a, b) =>
        String(a.source_key).localeCompare(String(b.source_key), "en"),
      ),
    );
    await writeRelationJsonl(
      stagingPaths["relations.jsonl"],
      resolved,
      fileSha,
      sourceFileName,
    );
    await writeRelationJsonl(
      stagingPaths["unresolved.jsonl"],
      unresolved,
      fileSha,
      sourceFileName,
    );

    const manifest: RepositoryRelationsManifest = {
      schema_version: "1.0",
      pass: "pass1",
      ok: errors.length === 0 && stats.parse_errors === 0,
      converted_at: new Date().toISOString(),
      source: {
        file_name: sourceFileName,
        relative_path: sourceRelativePath,
        file_sha256: fileSha,
        bytes,
        system_id: headerSystemId,
        export_type: headerExportType,
        schema_version: headerSchema,
        header_object_count: headerObjectCount,
        header_relation_count: headerRelationCount,
      },
      outputs: {
        objects: `canonical/${REPOSITORY_RELATIONS_CANONICAL_DIR}/objects.jsonl`,
        relations: `canonical/${REPOSITORY_RELATIONS_CANONICAL_DIR}/relations.jsonl`,
        unresolved: `canonical/${REPOSITORY_RELATIONS_CANONICAL_DIR}/unresolved.jsonl`,
        manifest: `canonical/${REPOSITORY_RELATIONS_CANONICAL_DIR}/manifest.json`,
      },
      stats,
      notes: [
        "Pass 1: streaming, no OpenAI, no index rebuild",
        "Dedupe key: from_type|from_name|relation_type|to_type|to_name",
        "contexts[] collects unique metadata / include contexts",
        "UNRESOLVED_* stored only in unresolved.jsonl",
        "Write-once atomic via staging rename",
        "Does not modify classes/programs/function-modules/message-idoc-config",
      ],
    };

    if (errors.length > 0) {
      manifest.ok = false;
    }

    writeFileSync(
      stagingPaths["manifest.json"],
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    // Atomic publish
    for (const name of REPOSITORY_RELATIONS_OUTPUTS) {
      const from = stagingPaths[name];
      const to = finalPaths[name];
      if (overwrite && existsSync(to)) {
        rmSync(to, { force: true });
      }
      renameSync(from, to);
    }

    return { ok: manifest.ok && errors.length === 0, manifest, errors };
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
        header_object_count: headerObjectCount,
        header_relation_count: headerRelationCount,
      }),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function writeJsonl(
  absolutePath: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const ws = createWriteStream(absolutePath, { flags: "w" });
  for (const row of rows) {
    if (!ws.write(`${JSON.stringify(row)}\n`)) {
      await new Promise<void>((resolve) => ws.once("drain", resolve));
    }
  }
  ws.end();
  await finished(ws);
}

async function writeRelationJsonl(
  absolutePath: string,
  map: Map<string, AccRelation>,
  fileSha: string,
  sourceFileName: string,
): Promise<void> {
  const rows = [...map.values()].sort((a, b) => {
    const ka = edgeKey(a);
    const kb = edgeKey(b);
    return ka.localeCompare(kb, "en");
  });
  const ws: WriteStream = createWriteStream(absolutePath, { flags: "w" });
  for (const r of rows) {
    const out = {
      schema_version: r.schema_version,
      record_type: "relation",
      system_id: r.system_id,
      from_type: r.from_type,
      from_name: r.from_name,
      relation_type: r.relation_type,
      to_type: r.to_type,
      to_name: r.to_name,
      occurrence_count: r.occurrence_count,
      contexts: [...r.contexts].sort((a, b) => a.localeCompare(b, "en")),
      _raw_ref: {
        file_name: sourceFileName,
        file_sha256: fileSha,
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
  params: ConvertRepositoryRelationsParams,
  stats: RepositoryRelationsStats,
  ok: boolean,
  sourceExtra?: Partial<RepositoryRelationsManifest["source"]>,
): RepositoryRelationsManifest {
  return {
    schema_version: "1.0",
    pass: "pass1",
    ok,
    converted_at: new Date().toISOString(),
    source: {
      file_name: params.sourceFileName,
      relative_path: params.sourceRelativePath,
      file_sha256: sourceExtra?.file_sha256 ?? "",
      bytes: sourceExtra?.bytes ?? 0,
      system_id: sourceExtra?.system_id ?? null,
      export_type: sourceExtra?.export_type ?? null,
      schema_version: sourceExtra?.schema_version ?? null,
      header_object_count: sourceExtra?.header_object_count ?? null,
      header_relation_count: sourceExtra?.header_relation_count ?? null,
    },
    outputs: {
      objects: `canonical/${REPOSITORY_RELATIONS_CANONICAL_DIR}/objects.jsonl`,
      relations: `canonical/${REPOSITORY_RELATIONS_CANONICAL_DIR}/relations.jsonl`,
      unresolved: `canonical/${REPOSITORY_RELATIONS_CANONICAL_DIR}/unresolved.jsonl`,
      manifest: `canonical/${REPOSITORY_RELATIONS_CANONICAL_DIR}/manifest.json`,
    },
    stats,
    notes: ["stub / failed convert"],
  };
}
