import path from "path";
import type { LocalProject } from "@/lib/localAuth/types";
import { getLocalDataRoot } from "@/lib/localData/root";
import {
  DEFAULT_PROCESS_CONFIG,
  UNCONFIGURED,
  type ProjectProcessConfig,
} from "@/lib/workflow/types";

export function mergeProcessConfig(
  partial?: Partial<ProjectProcessConfig> | null,
): ProjectProcessConfig {
  return { ...DEFAULT_PROCESS_CONFIG, ...(partial ?? {}) };
}

export function projectDataRoot(project: LocalProject): string {
  const override = project.local_data_root?.trim();
  if (override) return path.resolve(override);
  return path.join(getLocalDataRoot(), project.customer_id);
}

export type PlaceholderMap = Record<string, string>;

export function buildPlaceholderMap(project: LocalProject): PlaceholderMap {
  const cfg = mergeProcessConfig(project.process_config);
  const localRoot = (() => {
    try {
      return getLocalDataRoot();
    } catch {
      return UNCONFIGURED;
    }
  })();
  const projectRoot =
    localRoot === UNCONFIGURED
      ? UNCONFIGURED
      : projectDataRoot(project);

  const orUnconfigured = (value: string) => {
    const v = value.trim();
    return v ? v : UNCONFIGURED;
  };

  return {
    CUSTOMER_ID: project.customer_id || UNCONFIGURED,
    SYSTEM_ID: project.system_id || UNCONFIGURED,
    LOCAL_DATA_ROOT: localRoot,
    PROJECT_DATA_ROOT: projectRoot,
    PROJECT_NAME: project.name || UNCONFIGURED,
    SAP_SYSTEM_LABEL: orUnconfigured(
      applyPlaceholders(cfg.sap_system_label, {
        SYSTEM_ID: project.system_id || UNCONFIGURED,
        CUSTOMER_ID: project.customer_id || UNCONFIGURED,
      }),
    ),
    REPOSITORY_EXPORT_REPORT: orUnconfigured(cfg.repository_export_report),
    REPOSITORY_EXPORT_VARIANT: orUnconfigured(cfg.repository_export_variant),
    TABLE_DEFINITION_EXPORT_REPORT: orUnconfigured(
      cfg.table_definition_export_report,
    ),
    TABLE_CONTENT_EXPORT_REPORT: orUnconfigured(
      cfg.table_content_export_report,
    ),
    TABLE_EXPORT_VARIANT: orUnconfigured(cfg.table_export_variant),
    OBJECT_PREFIXES: orUnconfigured(cfg.object_prefixes),
    REPOSITORY_RAW_PATH: path.join(
      projectRoot === UNCONFIGURED ? "${PROJECT_DATA_ROOT}" : projectRoot,
      cfg.repository_raw_path,
    ),
    TABLE_DEFINITIONS_RAW_PATH: path.join(
      projectRoot === UNCONFIGURED ? "${PROJECT_DATA_ROOT}" : projectRoot,
      cfg.table_definitions_raw_path,
    ),
    TABLE_CONTENTS_RAW_PATH: path.join(
      projectRoot === UNCONFIGURED ? "${PROJECT_DATA_ROOT}" : projectRoot,
      cfg.table_contents_raw_path,
    ),
    ACTIVE_INDEX_PATH: project.active_index_path || "indexes/search",
  };
}

export function applyPlaceholders(
  text: string,
  map: PlaceholderMap,
): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
    if (key in map) return map[key]!;
    return `\${${key}}`;
  });
}

export function listUnconfiguredValues(map: PlaceholderMap): string[] {
  return Object.entries(map)
    .filter(([, v]) => v === UNCONFIGURED || v.includes(UNCONFIGURED))
    .map(([k]) => k);
}
