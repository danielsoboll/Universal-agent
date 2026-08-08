/**
 * Select question-relevant code units needing analysis, run OpenAI only for
 * cache misses/stale, persist, and sync indexes. No object-name hardcoding.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  analysesToJsonl,
  analyzeCodeUnit,
  parseCodeUnitsJsonl,
  parseUnitAnalysesJsonl,
  type CodeUnitInput,
} from "@/lib/analysis/analyzeCodeUnits";
import { loadKnownMacrosFromFragments } from "@/lib/analysis/macroExtract";
import { unitAnalysisRecordSchema } from "@/lib/analysis/unitAnalysisSchema";
import type { UnitAnalysisRecord } from "@/lib/analysis/unitAnalysisSchema";
import { OpenAIProvider } from "@/lib/ai/openaiProvider";
import { getLocalDataRoot } from "@/lib/localData/root";
import { resolveWritablePath } from "@/lib/localData/paths";
import { loadClassAnalysesMap } from "@/lib/knowledge/graphSelector";
import { syncClassAnalysesToHybrid } from "@/lib/search/syncClassAnalysesToHybrid";
import { buildPortableIndex } from "@/lib/portableIndex/buildPortableIndex";
import type { LocalProject } from "@/lib/localAuth/types";
import {
  clampExpandBudget,
  emptyKnowledgeExpansionReport,
  type KnowledgeExpansionReport,
} from "@/lib/knowledge/expandRelationKnowledge/types";
import { selectExpansionCandidates } from "@/lib/knowledge/expandRelationKnowledge/selectExpansionCandidates";

function projectKeyOf(project: LocalProject): string {
  return project.customer_id?.trim() || "P01";
}

function labelForUnit(u: {
  object_name?: string;
  unit_name?: string;
  source_key: string;
}): string {
  const o = u.object_name?.trim();
  const m = u.unit_name?.trim();
  if (o && m) return `${o} / ${m}`;
  return u.source_key;
}

function persistAnalyses(
  projectKey: string,
  records: UnitAnalysisRecord[],
): void {
  const abs = resolveWritablePath(
    projectKey,
    "analyses",
    "classes",
    "unit_analyses.jsonl",
  );
  const existing = existsSync(abs)
    ? parseUnitAnalysesJsonl(readFileSync(abs, "utf8"))
    : new Map<string, UnitAnalysisRecord>();
  for (const r of records) {
    existing.set(r.source_key, r);
  }
  const all = [...existing.values()].sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );
  writeFileSync(abs, analysesToJsonl(all), "utf8");
}

function loadMacros(projectKey: string): Set<string> {
  const fragmentsPath = resolveWritablePath(
    projectKey,
    "canonical",
    "classes/source_fragments.jsonl",
  );
  if (!existsSync(fragmentsPath)) return new Set();
  try {
    return loadKnownMacrosFromFragments(
      readFileSync(fragmentsPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .map((f) => ({
          fragment_type: String(f.fragment_type ?? ""),
          unit_type: String(f.unit_type ?? ""),
          source_code: String(f.source_code ?? ""),
        })),
    );
  } catch {
    return new Set();
  }
}

export type RunKnowledgeExpansionParams = {
  project: LocalProject;
  question: string;
  budget?: number;
  /** Vollanalyse-Pfad: Budget bis 25 erlaubt. */
  allowElevatedBudget?: boolean;
  systemId?: string;
  /**
   * Selection + ranking only — no OpenAI, no persist.
   * Used for diagnostics / dry-run.
   */
  dryRun?: boolean;
};

/**
 * Deterministic selection + targeted analysis. Does not synthesize an answer.
 */
export async function runKnowledgeExpansion(
  params: RunKnowledgeExpansionParams,
): Promise<KnowledgeExpansionReport> {
  const t0 = Date.now();
  const budget = clampExpandBudget(params.budget, {
    allowElevated: params.allowElevatedBudget,
  });
  const report = emptyKnowledgeExpansionReport(true);
  report.budget = budget;
  report.ran = true;

  const projectKey = projectKeyOf(params.project);
  const systemId = params.systemId || params.project.system_id || "D01";

  if (!params.dryRun && !process.env.OPENAI_API_KEY?.trim()) {
    report.notes.push("OPENAI_API_KEY fehlt — Expansion abgebrochen.");
    report.layers.still_open.push("OpenAI nicht konfiguriert");
    report.duration_ms = Date.now() - t0;
    return report;
  }

  const selection = await selectExpansionCandidates({
    project: params.project,
    question: params.question,
    systemId,
    maxCandidates: Math.max(40, budget * 4),
  });
  for (const n of selection.notes) report.notes.push(n);

  // Rank by technical relevance first — never by cache-miss alone.
  const pooled = selection.candidates;
  const needing = pooled.filter((s) => s.would_need_openai);
  const cached = pooled.filter((s) => s.cache_status === "hit");

  report.candidates_total = pooled.length;
  report.already_cached = cached.length;
  report.layers.preexisting = cached.slice(0, 12).map(labelForUnit);

  const toAnalyze = needing.slice(0, budget);
  const deferred = needing.slice(budget);
  report.deferred_source_keys = deferred.map((s) => s.source_key);
  report.layers.still_open = deferred.map(labelForUnit);

  if (params.dryRun) {
    report.notes.push(
      `Dry-Run: ${pooled.length} Kandidaten, ${needing.length} bräuchten Analyse, Top-Budget=${budget}. Kein OpenAI.`,
    );
    report.notes.push(
      `Top5: ${pooled
        .slice(0, 5)
        .map(
          (c) =>
            `${c.object_name}/${c.unit_name}(P${c.priority_tier},score=${c.relevance_score})`,
        )
        .join("; ")}`,
    );
    report.duration_ms = Date.now() - t0;
    return report;
  }

  if (toAnalyze.length === 0) {
    report.notes.push(
      "Keine fehlenden/stalen Method Analyses im relevanten technischen Umfeld.",
    );
    report.duration_ms = Date.now() - t0;
    return report;
  }

  const unitsAbs = resolveWritablePath(
    projectKey,
    "canonical",
    "classes",
    "code_units.jsonl",
  );
  const unitMap = new Map<string, CodeUnitInput>();
  if (existsSync(unitsAbs)) {
    for (const u of parseCodeUnitsJsonl(readFileSync(unitsAbs, "utf8"))) {
      unitMap.set(u.source_key, u);
    }
  }

  const provider = new OpenAIProvider();
  const macros = loadMacros(projectKey);
  const existingMap = loadClassAnalysesMap(projectKey);
  const written: UnitAnalysisRecord[] = [];

  for (const sel of toAnalyze) {
    const unit = unitMap.get(sel.source_key);
    if (!unit?.source_code) {
      report.failed.push({
        source_key: sel.source_key,
        error: "code_unit fehlt oder ohne source_code",
      });
      report.layers.still_open.push(labelForUnit(sel));
      continue;
    }
    const priorRaw = existingMap.get(sel.source_key);
    const priorParsed = priorRaw
      ? unitAnalysisRecordSchema.safeParse(priorRaw)
      : null;
    const prior: UnitAnalysisRecord | undefined = priorParsed?.success
      ? priorParsed.data
      : undefined;

    try {
      const result = await analyzeCodeUnit({
        unit,
        existing: prior,
        provider,
        knownMacros: macros,
      });
      if (!result.ok) {
        report.failed.push({
          source_key: sel.source_key,
          error: result.error.error,
        });
        report.layers.still_open.push(labelForUnit(sel));
        continue;
      }
      if (result.cache.hit) {
        report.already_cached += 1;
        report.layers.preexisting.push(labelForUnit(sel));
        continue;
      }
      written.push(result.record);
      report.analyzed_source_keys.push(sel.source_key);
      report.layers.newly_analyzed.push(labelForUnit(sel));
    } catch (e) {
      report.failed.push({
        source_key: sel.source_key,
        error: e instanceof Error ? e.message : String(e),
      });
      report.layers.still_open.push(labelForUnit(sel));
    }
  }

  report.analyzed_new = written.length;

  if (written.length === 0 && report.failed.length === 0) {
    report.notes.push(
      "Keine fehlenden/stalen Method Analyses im relevanten technischen Umfeld.",
    );
  }

  if (written.length > 0) {
    persistAnalyses(projectKey, written);
    report.notes.push(
      `${written.length} Method Analysis(en) persistent gespeichert.`,
    );

    try {
      await syncClassAnalysesToHybrid({
        projectKey,
        batchSize: Math.max(written.length, 10),
        dryRun: false,
        prioritize: [
          ...written.map((r) => r.class_name || ""),
          ...written.map((r) => r.source_key),
        ].filter(Boolean),
        systemId,
      });
      report.notes.push("Class-Index Sync (inkrementell) ausgeführt.");
    } catch (e) {
      report.notes.push(
        `Class-Index Sync fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    try {
      getLocalDataRoot();
      await buildPortableIndex({
        projectId: projectKey,
        systemId,
        force: true,
      });
      report.notes.push("Portable Access Indices aktualisiert.");
    } catch (e) {
      report.notes.push(
        `Portable Index fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  report.duration_ms = Date.now() - t0;
  return report;
}

export function formatExpansionLayersForPrompt(
  report: KnowledgeExpansionReport,
): string {
  if (!report.enabled || !report.ran) return "";
  return [
    "==== KNOWLEDGE EXPANSION (dieser Lauf) ====",
    `Budget=${report.budget}; neu analysiert=${report.analyzed_new}; Cache-Hits=${report.already_cached}; zurückgestellt=${report.deferred_source_keys.length}`,
    report.layers.preexisting.length
      ? `Bereits vorhandenes Wissen (Auszug): ${report.layers.preexisting.slice(0, 8).join("; ")}`
      : "Bereits vorhandenes Wissen: —",
    report.layers.newly_analyzed.length
      ? `Neu analysiert: ${report.layers.newly_analyzed.join("; ")}`
      : "Neu analysiert: keine",
    report.layers.still_open.length
      ? `Weiterhin offen / Vertiefung möglich: ${report.layers.still_open.slice(0, 10).join("; ")}`
      : "Weiterhin offen: —",
    "In der Antwort klar trennen: bestehend vs. neu analysiert vs. offen.",
    "==== ENDE KNOWLEDGE EXPANSION ====",
  ].join("\n");
}
