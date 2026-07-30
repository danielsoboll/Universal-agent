import type { MacroCall } from "@/lib/analysis/unitAnalysisSchema";
import { normalizeToken } from "@/lib/analysis/abapExtract";

export function parseDefinedMacros(sourceCode: string): Set<string> {
  const macros = new Set<string>();
  for (const match of sourceCode.matchAll(
    /\bDEFINE\s+([\/A-Za-z_][\/A-Za-z0-9_]*)/gi,
  )) {
    macros.add(normalizeToken(match[1] ?? ""));
  }
  return macros;
}

export function loadKnownMacrosFromFragments(
  fragments: Array<{ fragment_type?: string; unit_type?: string; source_code?: string }>,
): Set<string> {
  const macros = new Set<string>();
  for (const f of fragments) {
    const kind = String(f.fragment_type ?? f.unit_type ?? "").toUpperCase();
    if (kind !== "LOCAL_MACROS" && !String(f.source_code ?? "").includes("DEFINE ")) {
      continue;
    }
    for (const m of parseDefinedMacros(String(f.source_code ?? ""))) {
      macros.add(m);
    }
  }
  return macros;
}

/**
 * Detect ABAP macro invocations in method source.
 * Pattern: MACRO_NAME … at statement start (not after -> / => / CALL METHOD).
 */
export function extractMacroCalls(
  sourceCode: string,
  knownMacros: Set<string>,
): MacroCall[] {
  const lines = sourceCode.replace(/\r\n/g, "\n").split("\n");
  const found = new Map<string, MacroCall>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\s*\*/.test(raw)) continue;
    const codePart = raw.includes('"') ? raw.slice(0, raw.indexOf('"')) : raw;
    const trimmed = codePart.trim();
    if (!trimmed) continue;
    // skip method/attribute calls
    if (/->|=>|CALL\s+METHOD|CALL\s+FUNCTION|CREATE\s+OBJECT/i.test(trimmed)) {
      continue;
    }
    const m = trimmed.match(/^([\/A-Za-z_][\/A-Za-z0-9_]*)\b/);
    if (!m?.[1]) continue;
    const name = normalizeToken(m[1]);
    if (!name || name.length < 3) continue;

    const isKnown = knownMacros.has(name);
    const looksLikeMacro =
      isKnown ||
      /^ANNAHME_ZEITEN_/.test(name) ||
      /^LOG_(APP|SYS)_FAULT$/.test(name) ||
      name === "CREATE_OT_ORDER_POSITION";

    if (!looksLikeMacro) continue;

    const existing = found.get(name);
    if (!existing) {
      found.set(name, {
        name,
        line: i + 1,
        unresolved_macro: !isKnown,
      });
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function isMacroName(name: string, knownMacros: Set<string>): boolean {
  const n = normalizeToken(name);
  if (knownMacros.has(n)) return true;
  return (
    /^ANNAHME_ZEITEN_/.test(n) ||
    /^LOG_(APP|SYS)_FAULT$/.test(n) ||
    n === "CREATE_OT_ORDER_POSITION"
  );
}
