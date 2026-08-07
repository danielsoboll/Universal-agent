/**
 * Stage F — Relations expansion: only new anchors, dedupe, abort when weak/no growth.
 */
import { existsSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  AnchorSet,
  makeAnchor,
} from "@/lib/knowledge/multiSourceSearch/anchors";
import {
  asString,
  flattenStringValues,
  streamJsonlObjects,
  textMatchesAny,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import type {
  MultiSourceSearchPlan,
  SourceCoverage,
  StageEvidenceItem,
  StageResult,
} from "@/lib/knowledge/multiSourceSearch/types";

async function scanRelationsFile(params: {
  abs: string;
  pathHint: string;
  needles: string[];
  maxHits: number;
  sourceLabel: string;
}): Promise<{ hits: StageEvidenceItem[]; newAnchors: ReturnType<typeof makeAnchor>[] }> {
  const hits: StageEvidenceItem[] = [];
  const newAnchors: ReturnType<typeof makeAnchor>[] = [];
  if (!existsSync(params.abs) || params.needles.length === 0) {
    return { hits, newAnchors };
  }
  let scanned = 0;
  for await (const rec of streamJsonlObjects(params.abs)) {
    scanned += 1;
    if (scanned > 100_000 || hits.length >= params.maxHits) break;
    const blob = flattenStringValues(rec);
    const matched = textMatchesAny(blob, params.needles);
    if (!matched) continue;
    const from =
      asString(rec.from_object) ||
      asString(rec.source_object) ||
      asString(rec.object_name) ||
      asString(rec.from);
    const to =
      asString(rec.to_object) ||
      asString(rec.target_object) ||
      asString(rec.to_name) ||
      asString(rec.to);
    const relType =
      asString(rec.relation_type) ||
      asString(rec.type) ||
      asString(rec.record_type) ||
      "relation";
    hits.push({
      id: `rel:${params.sourceLabel}:${scanned}:${from}->${to}`,
      source: "relations",
      rank_tier: "relation",
      title: `${relType}: ${from || "?"} → ${to || "?"}`,
      summary: blob.slice(0, 300),
      object_name: from || to || undefined,
      anchors_matched: [matched],
      confidence: 0.6,
      path_hint: params.pathHint,
    });
    for (const name of [from, to]) {
      if (name && name.length >= 3) {
        newAnchors.push(
          makeAnchor({
            kind: /^[ZY]/i.test(name) && !name.includes("-") ? "object" : "symbol",
            value: name,
            source: "relations",
            confidence: 0.55,
          }),
        );
      }
    }
  }
  return { hits, newAnchors };
}

export async function runRelationsExpansionStage(params: {
  projectKey: string;
  plan: MultiSourceSearchPlan;
  anchors: AnchorSet;
  coverage: SourceCoverage;
  round: number;
  /** Anchors known before this expansion — only "new" ones count for abort. */
  priorAnchorCount: number;
}): Promise<StageResult> {
  const started = Date.now();
  const queries: StageResult["queries"] = [];
  const hits: StageEvidenceItem[] = [];
  const collectedNew = [];

  if (!params.coverage.exists) {
    return {
      stage: "relations",
      round: params.round,
      inputs: {
        anchors: params.anchors.strongNeedles(),
        concepts: params.plan.concepts,
        synonyms: params.plan.synonym_candidates,
      },
      queries: [],
      hits: [],
      new_anchors: [],
      confidence: 0,
      why_next: "Keine Relations-Quellen.",
      abort: true,
      abort_reason: params.coverage.diagnosis,
      coverage: params.coverage,
      duration_ms: Date.now() - started,
    };
  }

  const needles = params.anchors.strongNeedles();
  if (needles.length === 0) {
    return {
      stage: "relations",
      round: params.round,
      inputs: {
        anchors: [],
        concepts: params.plan.concepts,
        synonyms: params.plan.synonym_candidates,
      },
      queries: [],
      hits: [],
      new_anchors: [],
      confidence: 0.1,
      why_next: "Keine starken Anker für Expansion.",
      abort: true,
      abort_reason: "Expansion nur mit bewährten Ankern.",
      coverage: params.coverage,
      duration_ms: Date.now() - started,
    };
  }

  const files: { parts: string[]; hint: string; label: string }[] = [
    {
      parts: ["classes", "relations.jsonl"],
      hint: "canonical/classes/relations.jsonl",
      label: "classes",
    },
    {
      parts: ["programs", "relations.jsonl"],
      hint: "canonical/programs/relations.jsonl",
      label: "programs",
    },
    {
      parts: ["function-modules", "relations.jsonl"],
      hint: "canonical/function-modules/relations.jsonl",
      label: "fm",
    },
  ];

  for (const file of files) {
    const abs = resolveProjectZonePath(
      params.projectKey,
      "canonical",
      ...file.parts,
    );
    const { hits: fileHits, newAnchors } = await scanRelationsFile({
      abs,
      pathHint: file.hint,
      needles,
      maxHits: 8,
      sourceLabel: file.label,
    });
    hits.push(...fileHits);
    collectedNew.push(...newAnchors);
    queries.push({
      query: needles.slice(0, 8).join(" | "),
      purpose: `relations_stream:${file.label}`,
      hit_count: fileHits.length,
    });
  }

  const newAnchors = collectedNew.filter(Boolean) as NonNullable<
    ReturnType<typeof makeAnchor>
  >[];
  // Simulate add to measure growth — caller merges; we report candidates
  const temp = new AnchorSet();
  for (const a of params.anchors.list()) temp.add(a);
  const trulyNew = temp.addMany(newAnchors);
  const onlyWeak =
    hits.length > 0 &&
    hits.every((h) => h.rank_tier === "relation" || h.rank_tier === "semantic_weak") &&
    trulyNew.length === 0;

  const abort = trulyNew.length === 0 || onlyWeak;

  return {
    stage: "relations",
    round: params.round,
    inputs: {
      anchors: needles,
      concepts: params.plan.concepts,
      synonyms: params.plan.synonym_candidates,
    },
    queries,
    hits: hits.slice(0, 16),
    new_anchors: trulyNew,
    confidence: hits.length === 0 ? 0.1 : abort ? 0.35 : 0.6,
    why_next: abort
      ? "Keine neuen Anker — Runden abbrechen / Synthese."
      : "Neue Anker gefunden — ggf. weitere Runde.",
    abort,
    abort_reason: abort
      ? trulyNew.length === 0
        ? "Keine neuen Anker nach Expansion."
        : "Nur schwache Relations-Treffer ohne Anker-Wachstum."
      : undefined,
    coverage: params.coverage,
    duration_ms: Date.now() - started,
  };
}
