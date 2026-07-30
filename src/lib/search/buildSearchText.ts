/**
 * Deterministic search_text from structured SearchDocument fields.
 * Empty sections omitted. Originals stay in structured fields; text uses light normalize.
 */

export type SearchTextInput = {
  title?: string;
  object_type?: string;
  object_name?: string;
  subobject_name?: string;
  source_key?: string;
  knowledge_unit_type?: string;
  business_purpose?: string;
  technical_summary?: string;
  facts?: string[];
  inferences?: string[];
  tables_read?: string[];
  tables_written?: string[];
  called_methods?: string[];
  called_functions?: string[];
  macro_calls?: string[];
  hardcoded_values?: string[];
  external_interfaces?: string[];
  risks?: string[];
  relations?: Array<{
    relation_type: string;
    from_name?: string;
    to_name?: string;
    from_type?: string;
    to_type?: string;
  }>;
  entities?: Array<{ kind: string; name: string; normalized?: string }>;
  /** Short evidence hints only (not full quotes). */
  evidence_hints?: string[];
};

/** Collapse whitespace; keep case of originals for display in structured fields. */
export function normalizeSearchToken(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function nonEmpty(value: string | undefined | null): value is string {
  return typeof value === "string" && normalizeSearchToken(value).length > 0;
}

function section(title: string, lines: string[]): string[] {
  const cleaned = lines.map(normalizeSearchToken).filter((l) => l.length > 0);
  if (cleaned.length === 0) return [];
  return [title, ...cleaned];
}

function listSection(title: string, values: string[] | undefined, prefix?: string): string[] {
  const items = [...new Set((values ?? []).map(normalizeSearchToken).filter(Boolean))];
  if (items.length === 0) return [];
  return section(
    title,
    items.map((v) => (prefix ? `${prefix}${v}` : v)),
  );
}

/**
 * Build search_text in the fixed section order.
 */
export function buildSearchText(input: SearchTextInput): string {
  const parts: string[] = [];

  // 1. Titel und Objektidentität
  const identity: string[] = [];
  if (nonEmpty(input.title)) identity.push(normalizeSearchToken(input.title));
  const idBits = [
    input.knowledge_unit_type,
    input.object_type,
    input.object_name,
    input.subobject_name,
    input.source_key,
  ]
    .filter(nonEmpty)
    .map(normalizeSearchToken);
  if (idBits.length) identity.push(idBits.join(" | "));
  parts.push(...section("TITLE", identity));

  // 2. fachlicher Zweck
  if (nonEmpty(input.business_purpose)) {
    parts.push(...section("PURPOSE", [input.business_purpose!]));
  }

  // 3. technische Zusammenfassung
  if (nonEmpty(input.technical_summary)) {
    parts.push(...section("TECHNICAL", [input.technical_summary!]));
  }

  // 4. belegte Facts
  parts.push(
    ...listSection(
      "FACTS",
      (input.facts ?? []).map((f) => `FACT: ${f}`),
    ),
  );

  // 5. Inferences klar gekennzeichnet
  parts.push(
    ...listSection(
      "INFERENCES",
      (input.inferences ?? []).map((f) => `INFERENCE: ${f}`),
    ),
  );

  // 6. Tabellen und Datenobjekte
  const tables = [
    ...(input.tables_read ?? []).map((t) => `READ:${t}`),
    ...(input.tables_written ?? []).map((t) => `WRITE:${t}`),
  ];
  parts.push(...listSection("TABLES", tables));

  // 7. Methoden-, Funktions- und Makroaufrufe
  const calls = [
    ...(input.called_methods ?? []).map((m) => `METHOD:${m}`),
    ...(input.called_functions ?? []).map((f) => `FUNCTION:${f}`),
    ...(input.macro_calls ?? []).map((m) => `MACRO:${m}`),
  ];
  parts.push(...listSection("CALLS", calls));

  // 8. Hardcodings
  parts.push(...listSection("HARDCODED", input.hardcoded_values, "VALUE:"));

  // 9. externe Schnittstellen
  parts.push(...listSection("INTERFACES", input.external_interfaces, "IFACE:"));

  // 10. Risiken
  parts.push(...listSection("RISKS", input.risks, "RISK:"));

  // 11. relevante Relationen und Entities (+ kurze Evidence-Hinweise)
  const relationLines = (input.relations ?? [])
    .map((r) => {
      const from = [r.from_type, r.from_name].filter(nonEmpty).join(":");
      const to = [r.to_type, r.to_name].filter(nonEmpty).join(":");
      const bits = [r.relation_type, from, to].filter(nonEmpty);
      return bits.length ? bits.join(" ") : "";
    })
    .filter(Boolean);
  const entityLines = (input.entities ?? [])
    .map((e) => {
      const label = e.normalized && e.normalized !== e.name
        ? `${e.kind}:${e.name} (${e.normalized})`
        : `${e.kind}:${e.name}`;
      return normalizeSearchToken(label);
    })
    .filter(Boolean);
  parts.push(...listSection("RELATIONS", relationLines));
  parts.push(...listSection("ENTITIES", entityLines));
  parts.push(...listSection("EVIDENCE", input.evidence_hints));

  return parts.join("\n");
}
