/**
 * Aggregiert nützliche Wertesamples aus table_row-Hits (ohne Duplikat-Flut).
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";

function rowKeyValues(h: KnowledgeHit): Record<string, string> {
  const meta = h.metadata ?? {};
  const kv = meta.key_values;
  const out: Record<string, string> = {};
  if (kv && typeof kv === "object" && !Array.isArray(kv)) {
    for (const [k, v] of Object.entries(kv as Record<string, unknown>)) {
      out[String(k).toUpperCase()] = String(v ?? "").trim();
    }
  }
  // Fallback: parse "Wert X=Y" facts
  for (const f of h.facts ?? []) {
    const m = /^Wert\s+([A-Za-z0-9_]+)=(.+)$/.exec(f);
    if (m) out[m[1]!.toUpperCase()] = m[2]!.trim();
  }
  return out;
}

/**
 * Baut einen kompakten Werte-Katalog je Steuertabelle aus den Retrieval-Hits.
 */
export function buildControlValueCatalog(hits: KnowledgeHit[]): string {
  const byTable = new Map<string, Map<string, Set<string>>>();

  for (const h of hits) {
    if (h.knowledge_unit_type !== "table_row") continue;
    const table = (h.object_name || "").toUpperCase();
    if (!table) continue;
    const vals = rowKeyValues(h);
    if (Object.keys(vals).length === 0) continue;
    let fields = byTable.get(table);
    if (!fields) {
      fields = new Map();
      byTable.set(table, fields);
    }
    for (const [k, v] of Object.entries(vals)) {
      if (!v || k === "MANDT") continue;
      let set = fields.get(k);
      if (!set) {
        set = new Set();
        fields.set(k, set);
      }
      if (set.size < 24) set.add(v);
    }
  }

  if (byTable.size === 0) return "";

  const lines: string[] = [
    "### Werte-Katalog aus Steuertabellenzeilen (nur belegte Schlüssel/Werte)",
  ];
  for (const [table, fields] of [...byTable.entries()].slice(0, 8)) {
    lines.push(`Tabelle ${table}:`);
    for (const [field, values] of [...fields.entries()].slice(0, 10)) {
      const sample = [...values].slice(0, 16).join(", ");
      lines.push(`- ${field}: ${sample}`);
    }
  }
  return lines.join("\n");
}

/**
 * Nützlichkeitssignal: wie „prozesshaltig“ ist ein Hit für Synthesis?
 */
export function usefulnessScore(h: KnowledgeHit): number {
  let s = 0;
  const type = h.knowledge_unit_type;
  if (type === "master_field") s += 40;
  if (type === "code_unit") s += 35;
  if (type === "table_profile" || type === "control_table") s += 25;
  if (type === "table_row") s += 12;
  if (type === "message_idoc_object") s -= 20;
  const blob = `${h.title} ${h.snippet} ${h.technical_summary} ${(h.facts ?? []).join(" ")}`;
  if (/virtuell|ZZ_VLAGER|VLAGER|Confirm|Absage|AUART|ABGRU/i.test(blob)) s += 20;
  if ((h.matched_terms ?? []).some((t) => String(t).startsWith("phrase:"))) s += 25;
  if ((h.matched_terms ?? []).some((t) => String(t).startsWith("code_ref:"))) s += 15;
  if (/VIRTUELL|VLAGER/i.test(h.object_name) || /VIRTUELL|VLAGER/i.test(h.subobject_name)) {
    s += 30;
  }
  return s;
}

/** Behalte die nützlichsten Hits, sortiert nach usefulness dann Rang. */
export function selectUsefulHits(hits: KnowledgeHit[], limit: number): KnowledgeHit[] {
  return [...hits]
    .map((h, i) => ({ h, i, u: usefulnessScore(h) }))
    .filter((x) => x.u > 0)
    .sort((a, b) => b.u - a.u || a.h.rank - b.h.rank || a.i - b.i)
    .slice(0, limit)
    .map((x, i) => ({ ...x.h, rank: i + 1 }));
}
