import type { CanonicalTableRow } from "@/lib/ingest/controlTables/model";
import {
  extractLinkedTableNames,
  type TableCorpusBundle,
} from "@/lib/tables/loadCanonicalTables";
import {
  classificationConfidence,
  mapTableCategory,
} from "@/lib/tables/mapCategory";
import {
  sha256Stable,
  shortId,
  type TableKnowledgeUnit,
} from "@/lib/tables/types";

function codeRefsForTable(
  bundle: TableCorpusBundle,
  tableName: string,
): string[] {
  const refs = new Set<string>();
  for (const a of bundle.accesses) {
    if (a.table_name === tableName && a.code_source_key) {
      refs.add(a.code_source_key);
    }
  }
  for (const l of bundle.links) {
    const metaTable = l.metadata?.table_name;
    const toIsTable =
      l.to_type === "TABLE" &&
      (l.to_key === tableName || l.to_key.endsWith(`|${tableName}`));
    if (metaTable === tableName || toIsTable) {
      if (l.from_type === "CODE_UNIT" && l.from_key) refs.add(l.from_key);
    }
  }
  for (const d of bundle.dynamicAccesses) {
    if (d.table_name === tableName && d.code_source_key) {
      refs.add(d.code_source_key);
    }
  }
  return [...refs].sort();
}

function businessTermsFromArtifacts(params: {
  tableName: string;
  description: string;
  fieldDescriptions: string[];
  classificationReasons: string[];
}): string[] {
  const stop = new Set(
    [
      "der",
      "die",
      "das",
      "und",
      "oder",
      "für",
      "mit",
      "von",
      "zur",
      "zum",
      "bei",
      "aus",
      "eine",
      "einer",
      "eines",
      "einem",
      "welche",
      "welcher",
      "welches",
      "auch",
      "noch",
      "sind",
      "wird",
      "werden",
      "nach",
      "über",
      "ohne",
      "nur",
      "als",
      "pro",
      "the",
      "and",
      "for",
      "from",
    ].map((s) => s.toLowerCase()),
  );
  const terms = new Set<string>();
  const push = (t: string) => {
    const v = t.trim();
    if (v.length < 3 || v.length > 48) return;
    if (stop.has(v.toLowerCase())) return;
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_./-]{2,}$/.test(v)) return;
    terms.add(v);
  };
  push(params.tableName);
  for (const part of params.description.split(/[\s/;,|]+/)) push(part);
  for (const d of params.fieldDescriptions.slice(0, 40)) {
    for (const part of d.split(/[\s/;,|]+/)) push(part);
  }
  return [...terms].slice(0, 40);
}

function distinctKeyCount(rows: CanonicalTableRow[]): number {
  return new Set(
    rows.map((r) =>
      Object.entries(r.primary_key ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("|"),
    ),
  ).size;
}

export function buildTableKnowledgeUnits(params: {
  bundle: TableCorpusBundle;
  customerId: string;
  systemId: string;
  collisionCountByTable?: Map<string, number>;
  duplicateCountByTable?: Map<string, number>;
}): TableKnowledgeUnit[] {
  const linked = extractLinkedTableNames(params.bundle);
  const units: TableKnowledgeUnit[] = [];

  for (const def of params.bundle.definitions) {
    const cls =
      params.bundle.classificationByTable.get(def.table_name) ?? null;
    const rows = params.bundle.rowsByTable.get(def.table_name) ?? [];
    const code_references = codeRefsForTable(params.bundle, def.table_name);
    const category = mapTableCategory({ definition: def, classification: cls });
    const conf = classificationConfidence(cls);

    const facts: string[] = [
      `Tabelle ${def.table_name}`,
      def.description ? `Beschreibung: ${def.description}` : "",
      `Delivery Class ${def.delivery_class || "—"}`,
      cls ? `Klassifikation ${cls.classification} (Score ${cls.score})` : "",
      cls?.classification === "CUSTOMIZING_CONTROL_TABLE"
        ? "Export-Klassifikation: kundeneigene Customizing-/Steuertabelle"
        : "",
      cls?.classification === "REVIEW_CANDIDATE"
        ? "Export-Klassifikation: Review-Kandidat"
        : "",
      cls?.classification === "NON_CONTROL_TABLE"
        ? "Export-Klassifikation: keine Steuertabelle"
        : "",
      `Zeilen im Abzug: ${rows.length}`,
      def.key_fields?.length
        ? `Schlüsselfelder: ${def.key_fields.join(", ")}`
        : "Keine Schlüsselfelder in Definition",
      code_references.length
        ? `Code-Referenzen: ${code_references.length}`
        : "Keine bekannten Code-Referenzen",
    ].filter(Boolean);

    const inferences: string[] = [];
    if (cls?.reasons?.length) {
      inferences.push(
        `Klassifikationshinweise (exportiert): ${cls.reasons.slice(0, 6).join("; ")}`,
      );
    }
    if (category !== "unknown") {
      inferences.push(
        `Abgeleitete Grobkategorie ${category} aus Delivery Class/Klassifikation (nicht fachlich verifiziert)`,
      );
    }

    const evidence_refs = [
      `CanonicalTableDefinition:${def.source_key}`,
      cls ? `CanonicalTableClassification:${cls.source_key}` : "",
      ...rows.slice(0, 5).map((r) => `CanonicalTableRow:${r.source_key}`),
      ...code_references.slice(0, 8).map((c) => `CodeUnit:${c}`),
    ].filter(Boolean);

    const business_terms = businessTermsFromArtifacts({
      tableName: def.table_name,
      description: def.description ?? "",
      fieldDescriptions: (def.fields ?? []).map((f) => f.description ?? ""),
      classificationReasons: cls?.reasons ?? [],
    });

    const content_hash = sha256Stable([
      def.content_hash,
      cls?.content_hash ?? "",
      String(rows.length),
      code_references.join(","),
      category,
    ]);

    units.push({
      knowledge_unit_id: `tku:${shortId(content_hash)}:${def.table_name}`,
      customer_id: params.customerId,
      system_id: params.systemId,
      table_name: def.table_name,
      table_description: def.description ?? "",
      table_category: def.table_category ?? "",
      classification: cls?.classification ?? "UNCLASSIFIED",
      classification_confidence: conf,
      category,
      fields: (def.fields ?? []).map((f) => ({
        field_name: f.field_name,
        key: Boolean(f.key),
        data_element: f.data_element ?? "",
        data_type: f.data_type ?? "",
        length: f.length ?? 0,
        description: f.description ?? "",
      })),
      key_fields: def.key_fields ?? [],
      row_count: rows.length,
      distinct_key_count: distinctKeyCount(rows),
      duplicate_count: params.duplicateCountByTable?.get(def.table_name) ?? 0,
      collision_count: params.collisionCountByTable?.get(def.table_name) ?? 0,
      referenced_by_code: linked.has(def.table_name) || code_references.length > 0,
      code_references,
      business_terms,
      facts,
      inferences,
      evidence_refs,
      content_hash,
      package: def.package ?? "",
      delivery_class: def.delivery_class ?? "",
    });
  }

  return units.sort((a, b) => a.table_name.localeCompare(b.table_name));
}
