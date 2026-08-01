import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { LocalDataError } from "@/lib/localData/errors";
import { listRawEntries } from "@/lib/localData/fs";
import { resolveRawPath } from "@/lib/localData/paths";
import type { RawSourceFile, RebuildDataType } from "@/lib/rebuild/types";

export type RawFolderSpec = {
  /** Relative under raw/, e.g. control-tables/definitions */
  folderParts: string[];
  label: string;
  /** Required record_type values that must appear at least once (besides header). */
  requiredRecordTypes?: string[];
  /** Role for partner-file checks. */
  role?: "definitions" | "contents" | "single";
};

/** Designated raw folders per data type (exactly one *.jsonl each). */
export const RAW_FOLDER_SPECS: Record<RebuildDataType, RawFolderSpec[]> = {
  "control-tables": [
    {
      folderParts: ["control-tables", "definitions"],
      label: "raw/control-tables/definitions",
      requiredRecordTypes: ["table_definition"],
      role: "definitions",
    },
    {
      folderParts: ["control-tables", "contents"],
      label: "raw/control-tables/contents",
      requiredRecordTypes: ["table_row"],
      role: "contents",
    },
  ],
  classes: [{ folderParts: ["classes"], label: "raw/classes", role: "single" }],
  programs: [
    { folderParts: ["programs"], label: "raw/programs", role: "single" },
  ],
  materials: [
    {
      folderParts: ["master-data", "materials"],
      label: "raw/master-data/materials",
      role: "single",
    },
  ],
  customers: [
    {
      folderParts: ["master-data", "customers"],
      label: "raw/master-data/customers",
      role: "single",
    },
  ],
  vendors: [
    {
      folderParts: ["master-data", "vendors"],
      label: "raw/master-data/vendors",
      role: "single",
    },
  ],
};

const REQUIRED_FIELDS_BY_RECORD_TYPE: Record<string, string[]> = {
  table_definition: ["system_id", "client", "table_name"],
  table_classification: ["system_id", "client", "table_name", "classification"],
  table_row: ["system_id", "client", "table_name"],
};

export type StructuralRawValidation = {
  ok: boolean;
  sources: RawSourceFile[];
  folders: RawFolderSpec[];
  lines_read: number;
  errors: string[];
};

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function listJsonlInRawFolder(
  projectKey: string,
  folderParts: string[],
): RawSourceFile[] {
  const dirAbs = resolveRawPath(projectKey, ...folderParts);
  if (!existsSync(dirAbs)) {
    throw new LocalDataError(
      "NOT_FOUND",
      `Quellverzeichnis fehlt: raw/${folderParts.join("/")}`,
    );
  }
  if (!statSync(dirAbs).isDirectory()) {
    throw new LocalDataError(
      "NOT_FOUND",
      `Pfad ist kein Verzeichnis: raw/${folderParts.join("/")}`,
    );
  }

  const entries = listRawEntries(projectKey, ...folderParts).filter(
    (name) => !name.startsWith(".") && name.toLowerCase().endsWith(".jsonl"),
  );

  return entries
    .map((fileName) => {
      const absolutePath = resolveRawPath(projectKey, ...folderParts, fileName);
      return {
        relativePath: [...folderParts, fileName].join("/"),
        fileName,
        absolutePath,
        bytes: statSync(absolutePath).size,
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Picks the current SSOT file for a folder: exactly one *.jsonl, or if several
 * exist, the single structurally preferred file is not auto-picked — fail clear.
 * (Binding: current structurally valid file(s) win — designated folders only.)
 */
function pickDesignatedFile(
  folder: RawFolderSpec,
  files: RawSourceFile[],
): RawSourceFile {
  if (files.length === 0) {
    throw new Error(
      `Keine Quelldatei (*.jsonl) in ${folder.label}. Bitte genau eine Datei ablegen.`,
    );
  }
  if (files.length > 1) {
    const names = files.map((f) => f.fileName).join(", ");
    throw new Error(
      `Mehrere Quelldateien in ${folder.label}: ${names}. ` +
        `Es darf genau eine *.jsonl-Datei liegen (Single Source of Truth).`,
    );
  }
  return files[0]!;
}

function structurallyScanJsonl(params: {
  source: RawSourceFile;
  folder: RawFolderSpec;
}): { lines_read: number; errors: string[]; recordTypes: Set<string> } {
  const errors: string[] = [];
  const recordTypes = new Set<string>();
  const completeByType = new Set<string>();
  let lines_read = 0;
  let validObjects = 0;
  let invalidJson = 0;

  let text: string;
  try {
    text = readFileSync(params.source.absolutePath, "utf8");
  } catch (e) {
    return {
      lines_read: 0,
      errors: [
        `${params.folder.label}: Datei nicht lesbar — ${
          e instanceof Error ? e.message : String(e)
        }`,
      ],
      recordTypes,
    };
  }

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (!raw.trim()) continue;
    lines_read += 1;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      invalidJson += 1;
      continue;
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      invalidJson += 1;
      continue;
    }
    validObjects += 1;
    const obj = value as Record<string, unknown>;
    const recordType =
      typeof obj.record_type === "string" ? obj.record_type.trim() : "";
    if (!recordType) continue;
    recordTypes.add(recordType);
    if (recordType === "header") continue;

    const required = REQUIRED_FIELDS_BY_RECORD_TYPE[recordType];
    if (!required) continue;
    const missing = required.some((field) => {
      const v = obj[field];
      return v == null || (typeof v === "string" && !v.trim());
    });
    if (!missing) completeByType.add(recordType);
  }

  if (lines_read === 0) {
    errors.push(`${params.folder.label}: Datei enthält keine JSONL-Zeilen`);
  } else if (validObjects === 0) {
    errors.push(
      `${params.folder.label}: keine gültigen JSON-Objekte (ungültige Zeilen=${invalidJson})`,
    );
  }

  for (const rt of params.folder.requiredRecordTypes ?? []) {
    if (!recordTypes.has(rt)) {
      errors.push(
        `${params.folder.label}: erforderlicher record_type "${rt}" fehlt`,
      );
    } else if (!completeByType.has(rt)) {
      errors.push(
        `${params.folder.label}: kein vollständiger Datensatz für "${rt}" (Pflichtfelder fehlen)`,
      );
    }
  }

  return { lines_read, errors, recordTypes };
}

/**
 * Fully structurally validates designated RAW folders for a type.
 * Checks: present, readable, JSONL valid, required record_types, required fields,
 * partner file for groups. No quality/size/recency checks.
 */
export function validateRawSourcesForType(params: {
  projectKey: string;
  type: RebuildDataType;
}): StructuralRawValidation {
  const folders = RAW_FOLDER_SPECS[params.type];
  const sources: RawSourceFile[] = [];
  const errors: string[] = [];
  let lines_read = 0;

  for (const folder of folders) {
    try {
      const files = listJsonlInRawFolder(params.projectKey, folder.folderParts);
      const picked = pickDesignatedFile(folder, files);
      const buf = readFileSync(picked.absolutePath);
      const withHash: RawSourceFile = {
        ...picked,
        bytes: buf.length,
        sha256: sha256Buffer(buf),
      };
      const scan = structurallyScanJsonl({ source: withHash, folder });
      lines_read += scan.lines_read;
      errors.push(...scan.errors);
      sources.push(withHash);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Partner file: control-tables needs both definitions + contents
  if (params.type === "control-tables") {
    const hasDefs = sources.some((s) =>
      s.relativePath.includes("/definitions/"),
    );
    const hasContents = sources.some((s) =>
      s.relativePath.includes("/contents/"),
    );
    if (!hasDefs || !hasContents) {
      errors.push(
        "Partnerdateien unvollständig: raw/control-tables/definitions und raw/control-tables/contents werden beide benötigt.",
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Strukturelle RAW-Validierung fehlgeschlagen (${params.type}):\n` +
        errors.slice(0, 15).join("\n") +
        (errors.length > 15 ? `\n… und ${errors.length - 15} weitere` : ""),
    );
  }

  return { ok: true, sources, folders, lines_read, errors: [] };
}

/** Read-only listing for Admin UI (no throw on empty — returns status text). */
export function inspectRawSourcesForType(params: {
  projectKey: string;
  type: RebuildDataType;
}): {
  ok: boolean;
  sources: RawSourceFile[];
  message: string;
} {
  try {
    const { sources } = validateRawSourcesForType(params);
    return {
      ok: true,
      sources,
      message: `${sources.length} Quelldatei(en) strukturell geprüft.`,
    };
  } catch (error) {
    // Soft listing: still show whatever files exist without full validation
    const folders = RAW_FOLDER_SPECS[params.type];
    const soft: RawSourceFile[] = [];
    for (const folder of folders) {
      try {
        const files = listJsonlInRawFolder(
          params.projectKey,
          folder.folderParts,
        );
        soft.push(...files);
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      sources: soft,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
