/**
 * Generic SAP output medium (NACHA) text resolution.
 * Prefer config texts when exported; otherwise documented generic SAP mapping.
 * Never invent unknown codes.
 */
export type MediumResolution = {
  medium_code: string;
  medium_text: string;
  resolution: "CONFIG_TEXT" | "GENERIC_SAP_MAPPING" | "UNRESOLVED";
  source: string;
};

/**
 * Standard SAP output medium codes (NAST/TNAPR NACHA).
 * Documented generic mapping — not customer-specific.
 * Source: SAP standard documentation / domain values for NACHA.
 */
export const GENERIC_SAP_MEDIUM_MAP: Record<
  string,
  { text_de: string; text_en: string }
> = {
  "1": { text_de: "Druckausgabe", text_en: "Print output" },
  "2": { text_de: "Fax", text_en: "Fax" },
  "4": { text_de: "Telex", text_en: "Telex" },
  "5": { text_de: "Externe Sendung", text_en: "External send" },
  "6": { text_de: "EDI", text_en: "EDI" },
  "7": { text_de: "Einfache Mail", text_en: "Simple mail" },
  "8": { text_de: "Spezialfunktion", text_en: "Special function" },
  "9": { text_de: "Ereignisse (Workflow)", text_en: "Events (workflow)" },
  A: { text_de: "Verteilung (ALE)", text_en: "Distribution (ALE)" },
  T: { text_de: "Workflow-Aufgabe", text_en: "Workflow task" },
};

/** Optional runtime config texts: code → text (from export if present). */
const configTextOverrides = new Map<string, string>();

export function registerMediumConfigText(code: string, text: string): void {
  const c = code.trim().toUpperCase();
  const t = text.trim();
  if (c && t) configTextOverrides.set(c, t);
}

export function clearMediumConfigTexts(): void {
  configTextOverrides.clear();
}

export function resolveMedium(
  code: string | null | undefined,
  opts?: { preferLang?: "DE" | "EN" },
): MediumResolution {
  const raw = (code ?? "").trim();
  if (!raw) {
    return {
      medium_code: "",
      medium_text: "unbekannt",
      resolution: "UNRESOLVED",
      source: "empty",
    };
  }
  const key = raw.toUpperCase();
  const cfg = configTextOverrides.get(key);
  if (cfg) {
    return {
      medium_code: raw,
      medium_text: cfg,
      resolution: "CONFIG_TEXT",
      source: "registered_config_text",
    };
  }
  const mapped = GENERIC_SAP_MEDIUM_MAP[key] ?? GENERIC_SAP_MEDIUM_MAP[raw];
  if (mapped) {
    const lang = opts?.preferLang ?? "DE";
    return {
      medium_code: raw,
      medium_text: lang === "EN" ? mapped.text_en : mapped.text_de,
      resolution: "GENERIC_SAP_MAPPING",
      source: "GENERIC_SAP_MEDIUM_MAP (NACHA domain)",
    };
  }
  return {
    medium_code: raw,
    medium_text: "unbekannt",
    resolution: "UNRESOLVED",
    source: "no_mapping",
  };
}
