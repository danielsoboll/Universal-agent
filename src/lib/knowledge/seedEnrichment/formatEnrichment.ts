/**
 * Format enrichment pack for LLM prompt + synthetic KnowledgeHits.
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";
import type {
  FieldSeedEnrichment,
  PresentationHint,
  SeedEnrichmentPack,
} from "@/lib/knowledge/seedEnrichment/types";

function distLine(label: string, rows: { value: string; count: number }[]) {
  if (!rows.length) return "";
  return `${label}: ${rows.map((r) => `${r.value} (${r.count})`).join(", ")}`;
}

export function formatFieldEnrichmentBlock(
  e: FieldSeedEnrichment,
  hint: PresentationHint,
): string {
  const lines: string[] = [
    `### Cross-Source Enrichment für Seed ${e.seed.seed} (deterministisch)`,
    `Feld: ${e.ddic?.table_name ? `${e.ddic.table_name}-` : ""}${e.ddic?.field_name ?? e.seed.field_name}`,
  ];
  if (e.ddic?.description) {
    lines.push(`DDIC: ${e.ddic.description}`);
  }
  if (e.ddic?.data_element) {
    lines.push(
      `Data Element/Domain: ${e.ddic.data_element}${e.ddic.domain ? ` / ${e.ddic.domain}` : ""}`,
    );
  }
  if (e.observed_values.length) {
    lines.push(
      `Beobachtete Werte: ${e.observed_values.map((v) => `${v.value}=${v.count}`).join(", ")}`,
    );
  }
  if (e.master_instances.total_attributes > 0) {
    lines.push(
      `Master-Data-Instanzen: ${e.master_instances.total_attributes} Attribute / ${e.master_instances.distinct_owners} Sales Areas / ${e.master_instances.distinct_customers} Kunden`,
    );
    const d1 = distLine("VKORG", e.master_instances.vkorg_dist);
    const d2 = distLine("VTWEG", e.master_instances.vtweg_dist);
    const d3 = distLine("SPART", e.master_instances.spart_dist);
    if (d1) lines.push(d1);
    if (d2) lines.push(d2);
    if (d3) lines.push(d3);
    for (const s of e.master_instances.samples.slice(0, 5)) {
      lines.push(
        `  Beispiel: KUNNR=${s.kunnr ?? "—"} NAME1=${s.name1 ?? "—"} VKORG=${s.vkorg ?? "—"} VTWEG=${s.vtweg ?? "—"} SPART=${s.spart ?? "—"} Wert=${s.value} (evidence: ${s.relative_source_path})`,
      );
    }
    if (e.master_instances.total_attributes > e.master_instances.samples.length) {
      lines.push(
        `  … weitere ${e.master_instances.total_attributes - e.master_instances.samples.length} Instanzen in Entity-Index (nicht alle hier aufgeführt).`,
      );
    }
  }
  if (e.code_usage.total > 0) {
    lines.push(
      `Code-Usage: ${e.code_usage.total} Links (${Object.entries(e.code_usage.by_relation)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})`,
    );
    for (const c of e.code_usage.samples.slice(0, 6)) {
      lines.push(
        `  ${c.relation}: ${c.object_name}${c.subobject_name ? ` / ${c.subobject_name}` : ""} (${c.source_key})`,
      );
    }
  }
  if (e.config_neighbors.length) {
    lines.push(
      `Config/Graph-Nachbarn: ${e.config_neighbors
        .map((c) => `${c.object_name} [${c.relation_type}]`)
        .join(", ")}`,
    );
  }
  lines.push(`Presentation-Hint: ${hint}`);
  lines.push(
    "Pflicht: Diese belegten Counts/Beispiele in der Antwort erwähnen, wenn die Frage den Mechanismus, die Verwendung oder betroffene Instanzen betrifft. Keine vollständige Liste erzwingen.",
  );
  return lines.join("\n");
}

export function formatSeedEnrichmentPromptBlock(
  pack: SeedEnrichmentPack,
  hint: PresentationHint,
): string {
  if (!pack.enriched || pack.field_enrichments.length === 0) return "";
  return [
    "==== CROSS-SOURCE SEED ENRICHMENT (deterministisch, nach bestätigtem Seed) ====",
    ...pack.field_enrichments.map((e) => formatFieldEnrichmentBlock(e, hint)),
    "==== ENDE ENRICHMENT ====",
  ].join("\n\n");
}

function syntheticHit(
  id: string,
  title: string,
  facts: string[],
  source_key: string,
  rank: number,
  exact: number,
): KnowledgeHit {
  return {
    rank,
    search_document_id: id,
    source_key,
    title,
    knowledge_unit_type: "master_field",
    combined_score: 90,
    exact_score: exact,
    fulltext_score: 0,
    vector_score: 0,
    metadata_score: 0,
    confidence_bonus: 0,
    confidence: 1,
    matched_terms: ["seed_enrichment"],
    snippet: facts[0] ?? title,
    evidence_refs: [],
    facts,
    inferences: [],
    metadata: { seed_enrichment: true },
    object_name: title,
    object_type: "ENRICHMENT",
    subobject_name: "",
    technical_summary: facts.join(" · "),
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: [],
    entities: [],
    relations: [],
    evidence: facts.map((text) => ({
      statement_type: "fact" as const,
      text,
      lines: [],
    })),
    doc_confidence: 1,
  };
}

/** Turn enrichment into high-priority hits so synthesis/UI cannot ignore counts. */
export function enrichmentPackToHits(
  pack: SeedEnrichmentPack,
  startRank = 1,
): KnowledgeHit[] {
  const hits: KnowledgeHit[] = [];
  let rank = startRank;
  for (const e of pack.field_enrichments) {
    const fieldLabel = e.ddic?.table_name
      ? `${e.ddic.table_name}-${e.ddic.field_name}`
      : e.seed.field_name;
    const facts: string[] = [];
    if (e.ddic?.description) {
      facts.push(`DDIC ${fieldLabel}: ${e.ddic.description}`);
    }
    if (e.observed_values.length) {
      facts.push(
        `Beobachtete Werte von ${fieldLabel}: ${e.observed_values
          .map((v) => `${v.value} (${v.count}×)`)
          .join(", ")}`,
      );
    }
    if (e.master_instances.total_attributes > 0) {
      facts.push(
        `${fieldLabel} ist bei ${e.master_instances.total_attributes} Vertriebsbereichszuordnungen gesetzt (${e.master_instances.distinct_customers} Kunden).`,
      );
      const vk = e.master_instances.vkorg_dist
        .map((v) => `${v.value} (${v.count})`)
        .join(", ");
      if (vk) facts.push(`VKORG-Verteilung: ${vk}`);
      for (const s of e.master_instances.samples.slice(0, 3)) {
        facts.push(
          `Beispiel: ${s.kunnr ?? "?"} ${s.name1 ?? ""} — VKORG ${s.vkorg}/${s.vtweg}/${s.spart} = ${s.value}`,
        );
      }
    }
    if (e.code_usage.total > 0) {
      facts.push(
        `Code-Usage zu ${fieldLabel}: ${e.code_usage.total} belegte Links.`,
      );
      for (const c of e.code_usage.samples.slice(0, 4)) {
        facts.push(
          `${c.relation}: ${c.object_name}${c.subobject_name ? `→${c.subobject_name}` : ""}`,
        );
      }
    }
    for (const c of e.config_neighbors.slice(0, 4)) {
      facts.push(
        `Config/Graph-Nachbar: ${c.object_name} (${c.relation_type})`,
      );
    }
    if (!facts.length) continue;
    hits.push(
      syntheticHit(
        `enrichment:field:${e.seed.seed}`,
        `Enrichment ${fieldLabel}`,
        facts,
        e.ddic?.source_key || e.seed.seed,
        rank++,
        4,
      ),
    );
  }
  return hits;
}
