/**
 * Prepare MESSAGE_IDOC_CONFIG: detect 10 groups → header-validate →
 * per-table schema profiles → manifest.
 * No canonical conversion, OpenAI, embeddings, or index changes.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import {
  AREA_STATUS_LABELS,
  CANONICAL_OBJECT_TYPES,
  CONFIG_GROUPS,
  CONFIGURATION_RELATION_KINDS,
  EXCLUDED_MOVEMENT_HINTS,
  EXPECTED_GROUPS,
  EXPECTED_SOURCE_TABLES,
  LOG_FOLDER,
  MANIFEST_REL,
  PIPELINE_TYPE,
  RAW_FOLDER_PARTS,
  SCHEMA_PROFILES_DIR,
  STATUS_REL,
  isConfigGroup,
  type MessageIdocAreaStatus,
  type MessageIdocConfigGroup,
} from "@/lib/admin/datenbasis/messageIdocConfig/constants";
import { detectMessageIdocRawFiles } from "@/lib/admin/datenbasis/messageIdocConfig/detectRaw";
import {
  formalStatusLabel,
  schemaProfileKey,
  validateAndProfileJsonlFile,
} from "@/lib/admin/datenbasis/messageIdocConfig/validateAndProfile";
import type {
  InvalidRowReport,
  MessageIdocFileManifestEntry,
  MessageIdocRawManifest,
  MessageIdocStatusSnapshot,
  TableSchemaProfile,
} from "@/lib/admin/datenbasis/messageIdocConfig/types";
import { ensureRawScaffoldDir } from "@/lib/admin/datenbasis/projectStructure";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveRawPath, resolveWritablePath } from "@/lib/localData/paths";

function nowIso(): string {
  return new Date().toISOString();
}

export function ensureMessageIdocConfigFolders(projectKey: string): {
  raw: string;
  canonical: string;
  logs: string;
  profiles: string;
} {
  const raw = ensureRawScaffoldDir(projectKey, ...RAW_FOLDER_PARTS);
  const canonical = ensureWritableDir(
    projectKey,
    "canonical",
    "message-idoc-config",
  );
  const logs = ensureWritableDir(projectKey, "logs", "message-idoc-config");
  const profiles = ensureWritableDir(
    projectKey,
    "logs",
    "message-idoc-config",
    "schema-profiles",
  );
  return { raw, canonical, logs, profiles };
}

function computeAggregateSourceHash(files: MessageIdocFileManifestEntry[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    h.update(`${f.path}:${f.source_hash}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

function computeAggregateSchemaHash(profiles: TableSchemaProfile[]): string {
  const h = createHash("sha256");
  for (const p of [...profiles].sort((a, b) => {
    const ka = schemaProfileKey(String(a.config_group), a.source_table);
    const kb = schemaProfileKey(String(b.config_group), b.source_table);
    return ka.localeCompare(kb, "en");
  })) {
    h.update(
      `${schemaProfileKey(String(p.config_group), p.source_table)}:${p.schemaHash}\n`,
    );
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * Overall area status.
 * „unvollständig“ = nicht alle 10 Exportgruppen gefunden.
 * Fehlende Tabellen innerhalb einer vorhandenen Gruppe zählen nicht.
 */
export function deriveAreaStatus(params: {
  detectedGroups: MessageIdocConfigGroup[];
  validated: boolean;
  profilesWritten: number;
  readyForMapping: boolean;
  converted?: boolean;
  indexed?: boolean;
}): MessageIdocAreaStatus {
  if (params.indexed) return "indexiert";
  if (params.converted) return "konvertiert";
  if (params.detectedGroups.length === 0) return "keine_dateien";
  if (params.detectedGroups.length < EXPECTED_GROUPS) return "unvollstaendig";
  if (params.readyForMapping) return "bereit_fuer_mapping";
  if (params.profilesWritten > 0) return "schema_profiliert";
  if (params.validated) return "validiert";
  return "alle_gruppen_erkannt";
}

export function loadMessageIdocRawManifest(
  projectKey: string,
): MessageIdocRawManifest | null {
  try {
    const abs = resolveWritablePath(projectKey, "logs", MANIFEST_REL);
    if (!existsSync(abs)) return null;
    return JSON.parse(readFileSync(abs, "utf8")) as MessageIdocRawManifest;
  } catch {
    return null;
  }
}

function snapshotFromManifest(
  key: string,
  manifest: MessageIdocRawManifest | null,
  liveDetectedCount?: number,
): MessageIdocStatusSnapshot {
  if (!manifest) {
    const status = deriveAreaStatus({
      detectedGroups: [],
      validated: false,
      profilesWritten: 0,
      readyForMapping: false,
    });
    // If files exist on disk but no manifest yet, still show unvollständig/keine
    const detected = detectMessageIdocRawFiles(key);
    const groups = [
      ...new Set(
        detected
          .map((d) => d.configGroupFromFileName)
          .filter((g): g is MessageIdocConfigGroup => Boolean(g)),
      ),
    ];
    const liveStatus = deriveAreaStatus({
      detectedGroups: groups,
      validated: false,
      profilesWritten: 0,
      readyForMapping: false,
    });
    return {
      pipeline_type: PIPELINE_TYPE,
      project: key,
      status: liveStatus,
      status_label: AREA_STATUS_LABELS[liveStatus],
      expected_groups: EXPECTED_GROUPS,
      detected_groups: groups.length,
      missing_groups: CONFIG_GROUPS.filter((g) => !groups.includes(g)),
      duplicate_groups: [],
      file_count: liveDetectedCount ?? detected.length,
      valid_rows_total: 0,
      invalid_rows_total: 0,
      profiles_written: 0,
      manifest_path: null,
      updated_at: nowIso(),
      converted: false,
      indexed: false,
    };
  }

  const validTotal = manifest.files.reduce((a, f) => a + f.valid_rows, 0);
  const invalidTotal = manifest.files.reduce((a, f) => a + f.invalid_rows, 0);
  return {
    pipeline_type: PIPELINE_TYPE,
    project: key,
    status: manifest.status,
    status_label: AREA_STATUS_LABELS[manifest.status],
    expected_groups: manifest.expected_groups,
    detected_groups: manifest.detected_groups.length,
    missing_groups: manifest.missing_groups,
    duplicate_groups: manifest.duplicate_groups,
    file_count: manifest.files.length,
    valid_rows_total: validTotal,
    invalid_rows_total: invalidTotal,
    profiles_written: Object.keys(manifest.schema_profile_paths).length,
    manifest_path: `${LOG_FOLDER}/raw-manifest.json`,
    updated_at: manifest.updated_at,
    converted: false,
    indexed: false,
  };
}

export function loadMessageIdocStatus(
  projectKey: string,
): MessageIdocStatusSnapshot {
  return snapshotFromManifest(
    projectKey,
    loadMessageIdocRawManifest(projectKey),
  );
}

export type PrepareMessageIdocResult = {
  ok: boolean;
  message: string;
  status: MessageIdocStatusSnapshot;
  manifest: MessageIdocRawManifest;
};

export async function prepareMessageIdocConfig(
  projectKey: string,
): Promise<PrepareMessageIdocResult> {
  const key = projectKey.trim() || "P01";
  ensureMessageIdocConfigFolders(key);

  const detected = detectMessageIdocRawFiles(key);
  const notes: string[] = [
    "Keine Canonical-Konvertierung in diesem Schritt.",
    "Keine OpenAI-/Embedding-/Index-Schritte.",
    "Erkennung über config_group im Dateinamen und JSONL-Header.",
    "Fehlende releaseabhängige Quelltabellen sind kein Validierungsfehler.",
    "Z-/Y-Werte in Standard-Customizingtabellen bleiben erhalten (kein Z-/Y-Dateifilter).",
  ];

  const emptyManifest = (
    status: MessageIdocAreaStatus,
    extraNotes: string[],
  ): MessageIdocRawManifest => {
    const createdAt = nowIso();
    return {
      pipeline_type: PIPELINE_TYPE,
      project: key,
      status,
      expected_groups: EXPECTED_GROUPS,
      detected_groups: [],
      missing_groups: [...CONFIG_GROUPS],
      duplicate_groups: [],
      files: [],
      schema_hash: computeAggregateSchemaHash([]),
      source_hash: computeAggregateSourceHash([]),
      created_at: createdAt,
      updated_at: createdAt,
      invalid_row_samples: [],
      schema_profile_paths: {},
      planned_canonical_object_types: CANONICAL_OBJECT_TYPES,
      planned_relation_kinds: CONFIGURATION_RELATION_KINDS,
      excluded_movement_data: EXCLUDED_MOVEMENT_HINTS,
      expected_source_tables: EXPECTED_SOURCE_TABLES,
      notes: [...notes, ...extraNotes],
    };
  };

  if (detected.length === 0) {
    const status = "keine_dateien" as const;
    const prev = loadMessageIdocRawManifest(key);
    const manifest = emptyManifest(status, [
      "Keine JSONL-Dateien unter raw/message-idoc-config/ gefunden.",
    ]);
    if (prev?.created_at) manifest.created_at = prev.created_at;
    writeGeneratedText(
      key,
      "logs",
      MANIFEST_REL,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const snapshot = snapshotFromManifest(key, manifest);
    writeGeneratedText(
      key,
      "logs",
      STATUS_REL,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    return {
      ok: true,
      message: "Keine RAW-Dateien — Status: keine Dateien",
      status: snapshot,
      manifest,
    };
  }

  const fileEntries: MessageIdocFileManifestEntry[] = [];
  const allProfiles: TableSchemaProfile[] = [];
  const invalidSamples: InvalidRowReport[] = [];
  const schema_profile_paths: Record<string, string> = {};
  const groupToFiles = new Map<MessageIdocConfigGroup, string[]>();

  for (const file of detected) {
    const abs = resolveRawPath(key, ...RAW_FOLDER_PARTS, file.fileName);
    const result = await validateAndProfileJsonlFile(abs, file);

    const configGroup: MessageIdocConfigGroup | string | null =
      (result.header?.config_group &&
      isConfigGroup(String(result.header.config_group))
        ? (result.header.config_group as MessageIdocConfigGroup)
        : null) ?? file.configGroupFromFileName;

    if (configGroup && isConfigGroup(configGroup)) {
      const list = groupToFiles.get(configGroup) ?? [];
      list.push(file.fileName);
      groupToFiles.set(configGroup, list);
    }

    const profileKeys: string[] = [];
    for (const profile of result.tableProfiles) {
      const keyName = schemaProfileKey(
        String(profile.config_group),
        profile.source_table,
      );
      profileKeys.push(keyName);
      allProfiles.push(profile);
      const rel = `${SCHEMA_PROFILES_DIR}/${keyName}.json`;
      writeGeneratedText(
        key,
        "logs",
        rel,
        `${JSON.stringify(profile, null, 2)}\n`,
      );
      schema_profile_paths[keyName] = `logs/${rel}`;
    }

    invalidSamples.push(...result.invalidSamples);

    fileEntries.push({
      path: file.relativePath,
      fileName: file.fileName,
      config_group: configGroup,
      system_id: result.header?.system_id ?? null,
      client: result.header?.client ?? null,
      schema_version: result.header?.schema_version ?? null,
      tables_found: result.header?.tables_found ?? 0,
      tables_missing: result.header?.tables_missing ?? 0,
      missing_table_names: result.header?.missing_table_names ?? [],
      rows_exported_header: result.header?.rows_exported ?? null,
      rows_read: result.rowsRead,
      rows_by_source_table: result.rowsBySourceTable,
      record_type_counts: result.recordTypeCounts,
      valid_rows: result.validRows,
      invalid_rows: result.invalidRows,
      empty_lines: result.emptyLines,
      header_count: result.headerCount,
      duplicate_header: result.duplicateHeader,
      formal_status: result.formalStatus,
      formal_status_label: formalStatusLabel(result.formalStatus),
      source_hash: result.sourceHash,
      header_errors: result.headerErrors,
      warnings: result.warnings,
      schema_profile_keys: profileKeys,
    });
  }

  const detected_groups = CONFIG_GROUPS.filter((g) => groupToFiles.has(g));
  const missing_groups = CONFIG_GROUPS.filter((g) => !groupToFiles.has(g));
  const duplicate_groups = CONFIG_GROUPS.filter(
    (g) => (groupToFiles.get(g)?.length ?? 0) > 1,
  );

  if (duplicate_groups.length > 0) {
    notes.push(
      `Doppelte Gruppen (mehrere Dateien): ${duplicate_groups.join(", ")}`,
    );
  }
  if (missing_groups.length > 0) {
    notes.push(`Fehlende Gruppen: ${missing_groups.join(", ")}`);
  }

  for (const entry of fileEntries) {
    if (entry.formal_status === "keine_unterstuetzten_quelltabellen") {
      notes.push(
        `${entry.fileName}: keine unterstützten Quelltabellen im System`,
      );
    }
    if (entry.missing_table_names.length > 0) {
      notes.push(
        `${entry.fileName}: fehlende Tabellen protokolliert: ${entry.missing_table_names.join(", ")}`,
      );
    }
  }

  const validated = fileEntries.every(
    (f) =>
      f.formal_status === "ok" ||
      f.formal_status === "keine_unterstuetzten_quelltabellen",
  );

  const readyForMapping =
    detected_groups.length === EXPECTED_GROUPS &&
    duplicate_groups.length === 0 &&
    allProfiles.length > 0 &&
    validated;

  const status = deriveAreaStatus({
    detectedGroups: detected_groups,
    validated: validated || allProfiles.length > 0 || fileEntries.length > 0,
    profilesWritten: allProfiles.length,
    readyForMapping,
  });

  // Refine: if all 10 present and validated+profiled but not ready (e.g. no data rows)
  // status already handled by deriveAreaStatus order.

  const prev = loadMessageIdocRawManifest(key);
  const createdAt = prev?.created_at ?? nowIso();
  const updatedAt = nowIso();

  const manifest: MessageIdocRawManifest = {
    pipeline_type: PIPELINE_TYPE,
    project: key,
    status,
    expected_groups: EXPECTED_GROUPS,
    detected_groups,
    missing_groups,
    duplicate_groups,
    files: fileEntries,
    schema_hash: computeAggregateSchemaHash(allProfiles),
    source_hash: computeAggregateSourceHash(fileEntries),
    created_at: createdAt,
    updated_at: updatedAt,
    invalid_row_samples: invalidSamples.slice(0, 50),
    schema_profile_paths,
    planned_canonical_object_types: CANONICAL_OBJECT_TYPES,
    planned_relation_kinds: CONFIGURATION_RELATION_KINDS,
    excluded_movement_data: EXCLUDED_MOVEMENT_HINTS,
    expected_source_tables: EXPECTED_SOURCE_TABLES,
    notes,
  };

  writeGeneratedText(
    key,
    "logs",
    MANIFEST_REL,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const snapshot = snapshotFromManifest(key, manifest);
  writeGeneratedText(
    key,
    "logs",
    STATUS_REL,
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );

  return {
    ok: true,
    message: `RAW vorbereitet: ${fileEntries.length} Datei(en), ${detected_groups.length}/${EXPECTED_GROUPS} Gruppen, Status: ${AREA_STATUS_LABELS[status]}`,
    status: snapshot,
    manifest,
  };
}
