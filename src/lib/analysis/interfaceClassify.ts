export const EXTERNAL_INTERFACE_KINDS = [
  "sap_proxy_or_webservice",
  "rfc_destination",
  "http_or_rest",
  "file_interface",
  "idoc",
  "function_module",
  "external_system_name",
  "internal_method_or_variable",
] as const;

export type ExternalInterfaceKind = (typeof EXTERNAL_INTERFACE_KINDS)[number];

export type ClassifiedInterface = {
  kind: ExternalInterfaceKind;
  name: string;
  raw: string;
};

function cleanRaw(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function extractName(raw: string): string {
  const cleaned = cleanRaw(raw);
  const fm = cleaned.match(
    /Funktionsbaustein\s*:?\s*([A-Z0-9_\/]+)/i,
  );
  if (fm?.[1]) return fm[1].toUpperCase();
  const arrow = cleaned.match(/^([A-Z0-9_\/]+)->([A-Z0-9_\/]+)/i);
  if (arrow) return `${arrow[1]!.toUpperCase()}->${arrow[2]!.toUpperCase()}`;
  // Strip parenthetical commentary
  const beforeParen = cleaned.split("(")[0]?.trim() ?? cleaned;
  return beforeParen.toUpperCase();
}

/**
 * Classify a free-form external_interfaces string from older analyses / AI output.
 * Internal params, attributes and internal tables → internal_method_or_variable.
 */
export function classifyExternalInterface(raw: string): ClassifiedInterface {
  const text = cleanRaw(raw);
  const upper = text.toUpperCase();
  const name = extractName(text);

  // Explicit internal commentary
  if (/KLASSENVARIABLEN|INTERNE|IMPORT-TABELLE|EXPORT-TABELLE|PARAMETER/i.test(text)) {
    if (!/WEB\s*SERVICE|SOAP|PROXY|RFC|IDoc|HTTP|REST|FILE|DATEI/i.test(text)) {
      return { kind: "internal_method_or_variable", name, raw: text };
    }
  }

  // Import/export/changing style params and program variables
  if (/^(I_|E_|C_|L_|G_|LT_|GT_|LS_|GS_|IT_|IS_|WA_|P_|R_)[A-Z0-9_]*/.test(name)) {
    return { kind: "internal_method_or_variable", name, raw: text };
  }

  // Exception classes from AI runtime — not business interfaces
  if (/^CX_AI_/.test(name) || /\bCX_AI_/.test(upper)) {
    return { kind: "internal_method_or_variable", name, raw: text };
  }

  // DDIC tables wrongly listed as interfaces
  if (/^(VBPA|KNVA|VBSK|MARA|VBAK|VBAP|EKKO|EKPO|ZEXTO_)/.test(name) && !name.includes("->")) {
    return { kind: "internal_method_or_variable", name, raw: text };
  }

  if (/\bIDOC\b|\/IDOC/i.test(text)) {
    return { kind: "idoc", name, raw: text };
  }
  if (/\bRFC\b|DESTINATION\b/i.test(text)) {
    return { kind: "rfc_destination", name, raw: text };
  }
  if (/\bHTTP\b|\bREST\b|\bURL\b|\bOData\b/i.test(text)) {
    return { kind: "http_or_rest", name, raw: text };
  }
  if (/\bFILE\b|DATEI|DATASET|OPEN DATASET|CSV|XML-DATEI/i.test(text)) {
    return { kind: "file_interface", name, raw: text };
  }

  if (
    /LOGICAL[_\s-]?PORT|SOAP|WEBSERVICE|WEB\s*SERVICE|PROXY|ZCO_|ZOTCO_/i.test(
      text,
    )
  ) {
    return { kind: "sap_proxy_or_webservice", name, raw: text };
  }

  if (/FUNKTIONSBAUSTEIN|CALL FUNCTION/i.test(text) || /^[A-Z0-9_\/]+$/.test(name) && /_/.test(name) && !name.startsWith("ZCL_")) {
    // Function-module-like tokens (DATE_COMPUTE_DAY, READ_TEXT, …)
    if (/FUNKTIONSBAUSTEIN/i.test(text) || /^(DATE_|SD_|READ_|CACL_|NUMBER_)/.test(name)) {
      return { kind: "function_module", name, raw: text };
    }
  }

  if (/FUNKTIONSBAUSTEIN/i.test(text)) {
    return { kind: "function_module", name, raw: text };
  }

  // External system labels
  if (/OPTITOOL|PRODSYSTEM|TESTSYSTEM|TESTSYS/i.test(text)) {
    return { kind: "external_system_name", name, raw: text };
  }

  // Proxy class method style ZCO_IMPORT_NEW3->UPDATE_DEPOT
  if (/^ZCO_[A-Z0-9_]*->/i.test(name) || /^ZOTCO_/i.test(name)) {
    return { kind: "sap_proxy_or_webservice", name, raw: text };
  }

  // Local/helper classes
  if (/^ZCL_/i.test(name)) {
    return { kind: "internal_method_or_variable", name, raw: text };
  }

  // Default: treat unknown plain identifiers as internal unless clearly external
  return { kind: "internal_method_or_variable", name, raw: text };
}

export function partitionExternalInterfaces(rawValues: string[] | undefined): {
  classified: ClassifiedInterface[];
  real: ClassifiedInterface[];
  discarded: ClassifiedInterface[];
} {
  const classified = (rawValues ?? []).map(classifyExternalInterface);
  const real = classified.filter((c) => c.kind !== "internal_method_or_variable");
  const discarded = classified.filter(
    (c) => c.kind === "internal_method_or_variable",
  );
  return { classified, real, discarded };
}
