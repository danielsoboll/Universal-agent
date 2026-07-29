/**
 * Extract known technical SAP/custom-code keys from a JSON object.
 * Does not invent business meaning — only copies present values under stable keys.
 */

const FIELD_ALIASES: Record<string, string[]> = {
  programm: ["programm", "program", "progname", "prog", "report"],
  include: ["include", "include_name", "includename"],
  tabelle: ["tabelle", "table", "tabname", "ddic_table"],
  feld: ["feld", "field", "fieldname", "fname"],
  objekt: ["objekt", "object", "obj_name", "object_name", "objname"],
  zeilennummer: [
    "zeilennummer",
    "line",
    "line_number",
    "lineno",
    "zeile",
    "row",
  ],
  kommentar: ["kommentar", "comment", "comments", "beschreibung", "description"],
  code: ["code", "source", "source_code", "abap", "snippet", "content"],
  nutzungstyp: ["nutzungstyp", "usage_type", "usage", "use_type", "type"],
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function asPlainString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

export type TechnicalSapFields = {
  programm?: string;
  include?: string;
  tabelle?: string;
  feld?: string;
  objekt?: string;
  zeilennummer?: string;
  kommentar?: string;
  code?: string;
  nutzungstyp?: string;
};

export function extractTechnicalFields(value: unknown): TechnicalSapFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const input = value as Record<string, unknown>;
  const byNormalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    byNormalized[normalizeKey(k)] = v;
  }

  const out: TechnicalSapFields = {};
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (!(alias in byNormalized)) continue;
      const asString = asPlainString(byNormalized[alias]);
      if (asString == null || asString.trim() === "") continue;
      out[canonical as keyof TechnicalSapFields] = asString;
      break;
    }
  }
  return out;
}

/** Build prepared_content from technical fields only — no interpretation. */
export function buildPreparedContent(
  fields: TechnicalSapFields,
  fallbackRaw: string,
): string {
  const labels: Array<[keyof TechnicalSapFields, string]> = [
    ["programm", "Programm"],
    ["include", "Include"],
    ["tabelle", "Tabelle"],
    ["feld", "Feld"],
    ["objekt", "Objekt"],
    ["zeilennummer", "Zeilennummer"],
    ["nutzungstyp", "Nutzungstyp"],
    ["kommentar", "Kommentar"],
    ["code", "Code"],
  ];

  const parts: string[] = [];
  for (const [key, label] of labels) {
    const value = fields[key];
    if (value == null || value === "") continue;
    parts.push(`${label}: ${value}`);
  }

  if (parts.length === 0) {
    return fallbackRaw;
  }
  return parts.join("\n");
}

export function buildUnitTitle(
  fields: TechnicalSapFields,
  lineNumber: number,
): string {
  const bits = [
    fields.programm,
    fields.include,
    fields.objekt,
    fields.tabelle && fields.feld
      ? `${fields.tabelle}-${fields.feld}`
      : fields.tabelle || fields.feld,
  ].filter(Boolean);
  if (bits.length > 0) {
    return bits.join(" / ");
  }
  return `Zeile ${lineNumber}`;
}
