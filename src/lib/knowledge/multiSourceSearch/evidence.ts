/**
 * Evidence budgets + ranking: evidence_type > rank_tier > confidence.
 */
import {
  compareEvidenceItems,
  rankTierToEvidenceType,
  scoreEvidenceItem,
} from "@/lib/knowledge/multiSourceSearch/evidenceScoring";
import { isGenericMessageNoise } from "@/lib/knowledge/multiSourceSearch/primaryAnchor";
import type {
  MultiSourceEvidenceBundle,
  MultiSourceId,
  MultiSourceSearchPlan,
  SpecializedSearchPlan,
  StageEvidenceItem,
  StructuredSearchContext,
} from "@/lib/knowledge/multiSourceSearch/types";

export function bundleEvidence(params: {
  items: StageEvidenceItem[];
  plan: MultiSourceSearchPlan;
}): MultiSourceEvidenceBundle {
  const bySource: Record<MultiSourceId, StageEvidenceItem[]> = {
    exact_symbol: [],
    master_data: [],
    control_tables: [],
    classes: [],
    programs: [],
    function_modules: [],
    relations: [],
  };

  const selected: StageEvidenceItem[] = [];
  const ranking_notes: string[] = [];
  let omitted = 0;

  const specialized = params.plan.specialized;
  const symbolObjects = specialized?.primary_anchor?.objects ?? [];
  const symbols = [
    specialized?.primary_anchor?.symbol,
    ...(symbolObjects ?? []),
  ].filter(Boolean) as string[];
  const techMode =
    specialized?.plan_type === "TECHNICAL_SYMBOL_TO_PROCESS" &&
    symbols.length > 0;

  const q = params.plan.question.toLowerCase();
  const allowAbapgit = /abapgit|\bgit\b/.test(q);
  const seen = new Set<string>();
  const discarded: string[] = [];

  for (const item of params.items) {
    if (seen.has(item.id)) continue;
    if (
      !allowAbapgit &&
      /ABAPGIT/i.test(`${item.title} ${item.object_name ?? ""}`)
    ) {
      omitted += 1;
      continue;
    }

    if (techMode) {
      if (isGenericMessageNoise(item, symbolObjects, symbols)) {
        discarded.push(`${item.source}:${item.title}`);
        omitted += 1;
        continue;
      }
      // Unrelated control_tables / master_data without symbol mention
      if (
        (item.source === "control_tables" || item.source === "master_data") &&
        item.rank_tier !== "exact"
      ) {
        const blob =
          `${item.title} ${item.table_name ?? ""} ${item.summary}`.toUpperCase();
        const related = symbols.some((s) => blob.includes(s.toUpperCase()));
        if (!related && !item.related_to_symbol) {
          discarded.push(`${item.source}:${item.title}`);
          omitted += 1;
          continue;
        }
      }
    }

    seen.add(item.id);
    const enriched = {
      ...item,
      evidence_type: item.evidence_type ?? rankTierToEvidenceType(item),
      score: scoreEvidenceItem(item),
    };
    bySource[item.source].push(enriched);
  }

  if (discarded.length) {
    ranking_notes.push(
      `Verworfen (kein Bezug zum technischen Symbol): ${discarded.slice(0, 12).join(" | ")}${discarded.length > 12 ? "…" : ""}`,
    );
  }

  for (const source of params.plan.source_order) {
    const budget = params.plan.budgets[source] ?? 8;
    const sorted = [...bySource[source]].sort(compareEvidenceItems);
    const take = sorted.slice(0, budget);
    omitted += Math.max(0, sorted.length - take.length);
    selected.push(...take);
    ranking_notes.push(
      `${source}: ${sorted.length} → ${take.length} (Budget ${budget}; Tiers ${summarizeTiers(take)})`,
    );
  }

  // Global soft cap — keep per-source picks; trim weak tiers first
  const GLOBAL_CAP = 56;
  if (selected.length > GLOBAL_CAP) {
    selected.sort(compareEvidenceItems);
    omitted += selected.length - GLOBAL_CAP;
    selected.length = GLOBAL_CAP;
    ranking_notes.push(`Global cap ${GLOBAL_CAP} angewendet (schwache Tiers zuerst gekürzt).`);
  }

  // Prefer exact_symbol first in final order for TECHNICAL_SYMBOL plans
  if (techMode) {
    selected.sort((a, b) => {
      if (a.source === "exact_symbol" && b.source !== "exact_symbol") return -1;
      if (b.source === "exact_symbol" && a.source !== "exact_symbol") return 1;
      return compareEvidenceItems(a, b);
    });
  }

  const counts = {
    exact_symbol: 0,
    master_data: 0,
    control_tables: 0,
    classes: 0,
    programs: 0,
    function_modules: 0,
    relations: 0,
  } as Record<MultiSourceId, number>;
  for (const s of selected) counts[s.source] += 1;

  return {
    items: selected,
    by_source: counts,
    omitted,
    ranking_notes,
  };
}

function summarizeTiers(items: StageEvidenceItem[]): string {
  const c: Record<string, number> = {};
  for (const i of items) c[i.rank_tier] = (c[i.rank_tier] ?? 0) + 1;
  return Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

export function buildFinalContext(params: {
  question: string;
  plan: MultiSourceSearchPlan;
  evidence: MultiSourceEvidenceBundle;
  coverageNotes: string[];
  structured?: StructuredSearchContext;
  specialized?: SpecializedSearchPlan;
}): string {
  const lines: string[] = [
    `Frage: ${params.question}`,
    "",
  ];

  if (params.specialized?.primary_anchor) {
    const a = params.specialized.primary_anchor;
    if (a.anchor_type === "TECHNICAL_SYMBOL") {
      lines.push(
        `Primäranker (TECHNICAL_SYMBOL): Token=${a.symbol ?? a.table}`,
      );
      if (a.user_object_type_guess) {
        lines.push(
          `Hinweis: Benutzer nannte Objekttyp „${a.user_object_type_guess}“ — kein belegtes Objekt dieses Typs für ${a.symbol ?? a.table} gefunden; technische Namens-Treffer haben Vorrang.`,
        );
      }
      if (a.objects?.length) {
        lines.push(`Gefundene Objekte mit ${a.symbol}:`);
        for (const o of a.objects.slice(0, 12)) {
          lines.push(`  - ${o}`);
        }
      }
      lines.push(
        `Antwortvorgabe: „Ein eindeutiges Objekt vom Typ ${a.user_object_type_guess ?? "genannt"} ${a.symbol} wurde nicht gefunden. Es existieren jedoch folgende technische Objekte mit ${a.symbol} im Namen: ${(a.objects ?? []).slice(0, 6).join(", ")}.“ Dann Caller/Callees/Tabellen aus Evidenz erklären. Keine generischen MESSAGE-Tabellen ohne Relation.`,
      );
    } else {
      lines.push(
        `Primäranker (${params.specialized.plan_type}): ${a.table}-${a.field ?? "—"}`,
      );
      if (a.description) {
        lines.push(`  Beschreibung: ${a.description}`);
      }
    }
    lines.push("");
  }

  if (params.structured) {
    lines.push("Strukturierter Kontext (JSON):");
    lines.push(JSON.stringify(params.structured, null, 2).slice(0, 6000));
    lines.push("");
  }

  lines.push(
    `Konzepte: ${params.plan.concepts.join(", ")}`,
    `Synonyme: ${params.plan.synonym_candidates.slice(0, 20).join(", ")}`,
    "",
    "Coverage:",
    ...params.coverageNotes.map((n) => `- ${n}`),
    "",
    "Evidenz (kuratiert, nach Quelle/Rang):",
  );

  let i = 1;
  for (const item of params.evidence.items) {
    lines.push(
      `[${i}] (${item.source}/${item.evidence_type ?? item.rank_tier}/score=${item.score ?? 0}/c=${item.confidence.toFixed(2)}) ${item.title}`,
    );
    lines.push(`    ${item.summary}`);
    if (item.table_name) lines.push(`    table=${item.table_name}`);
    if (item.field_name) lines.push(`    field=${item.field_name}`);
    if (item.object_type) lines.push(`    object_type=${item.object_type}`);
    if (item.tables_read?.length) {
      lines.push(`    tables_read=${item.tables_read.join(",")}`);
    }
    if (item.tables_written?.length) {
      lines.push(`    tables_written=${item.tables_written.join(",")}`);
    }
    if (item.called_functions?.length) {
      lines.push(`    called_functions=${item.called_functions.join(",")}`);
    }
    if (item.evidence_lines?.length) {
      lines.push(`    evidence_lines=${item.evidence_lines.join(" | ")}`);
    }
    if (item.values) {
      lines.push(
        `    values=${JSON.stringify(item.values).slice(0, 200)}`,
      );
    }
    if (item.anchors_matched.length) {
      lines.push(`    anchors=${item.anchors_matched.join(", ")}`);
    }
    if (item.path_hint) lines.push(`    path=${item.path_hint}`);
    i += 1;
  }

  lines.push("");
  lines.push("Ranking-Notizen:");
  for (const n of params.evidence.ranking_notes) lines.push(`- ${n}`);

  return lines.join("\n");
}
