/**
 * Execute planner next_actions against existing knowledge layers.
 * No SAP export. No final answer synthesis.
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
import type { UnitAnalysisRecord } from "@/lib/analysis/unitAnalysisSchema";
import { OpenAIProvider } from "@/lib/ai/openaiProvider";
import { resolveWritablePath } from "@/lib/localData/paths";
import type { LocalProject } from "@/lib/localAuth/types";
import type { DomainSearchProfile } from "@/lib/domain/types";
import {
  KnowledgeRetriever,
  type KnowledgeHit,
} from "@/lib/knowledge/knowledgeRetriever";
import { syncClassAnalysesToHybrid } from "@/lib/search/syncClassAnalysesToHybrid";
import type { ResearchNextAction } from "@/lib/knowledge/fullAnalysisResearch/types";

function projectKeyOf(project: LocalProject): string {
  return project.customer_id?.trim() || "P01";
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
  for (const r of records) existing.set(r.source_key, r);
  const all = [...existing.values()].sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );
  writeFileSync(abs, analysesToJsonl(all), "utf8");
}

function resolveMethodTargets(
  projectKey: string,
  targets: string[],
): CodeUnitInput[] {
  const abs = resolveWritablePath(
    projectKey,
    "canonical",
    "classes/code_units.jsonl",
  );
  if (!existsSync(abs) || targets.length === 0) return [];
  const wanted = targets.map((t) => t.trim().toUpperCase()).filter(Boolean);
  const out: CodeUnitInput[] = [];
  const seen = new Set<string>();
  for (const u of parseCodeUnitsJsonl(readFileSync(abs, "utf8"))) {
    if (String(u.unit_type ?? "").toUpperCase() !== "METHOD") continue;
    if (!u.source_key || !u.source_code) continue;
    const sk = u.source_key.toUpperCase();
    const classMethod = `${u.object_name}.${u.unit_name}`.toUpperCase();
    const slash = `${u.object_name}/${u.unit_name}`.toUpperCase();
    const hit = wanted.some(
      (t) =>
        sk.includes(t) ||
        classMethod === t ||
        slash === t ||
        u.object_name.toUpperCase() === t ||
        u.unit_name.toUpperCase() === t ||
        t.includes(u.object_name.toUpperCase()),
    );
    if (!hit || seen.has(u.source_key)) continue;
    seen.add(u.source_key);
    out.push(u);
    if (out.length >= 40) break;
  }
  return out;
}

async function searchTyped(params: {
  project: LocalProject;
  query: string;
  searchProfile: DomainSearchProfile;
  types: string[];
  limit: number;
  enableRelationExpansion?: boolean;
}): Promise<{
  hits: KnowledgeHit[];
  embedding_tokens: number;
  embedding_cost: number;
}> {
  const result = await KnowledgeRetriever.search({
    project: params.project,
    query: params.query,
    limit: params.limit,
    searchProfile: params.searchProfile,
    enableRelationExpansion: params.enableRelationExpansion ?? false,
    filters: { knowledge_unit_types: params.types },
  });
  return {
    hits: result.hits,
    embedding_tokens: result.query_embedding_tokens,
    embedding_cost: result.query_embedding_cost,
  };
}

export type ExecuteResearchActionsResult = {
  hits: KnowledgeHit[];
  new_analyses: string[];
  openai_calls: number;
  embedding_tokens: number;
  embedding_cost: number;
  notes: string[];
};

export async function executeResearchActions(params: {
  project: LocalProject;
  question: string;
  searchProfile: DomainSearchProfile;
  actions: ResearchNextAction[];
  analysesBudgetLeft: number;
  openaiCallsLeft: number;
  systemId?: string;
}): Promise<ExecuteResearchActionsResult> {
  const projectKey = projectKeyOf(params.project);
  const systemId = params.systemId || params.project.system_id || "D01";
  const hits: KnowledgeHit[] = [];
  const new_analyses: string[] = [];
  const notes: string[] = [];
  let openai_calls = 0;
  let embedding_tokens = 0;
  let embedding_cost = 0;
  let analysesLeft = params.analysesBudgetLeft;
  let openaiLeft = params.openaiCallsLeft;

  for (const action of params.actions) {
    if (openaiLeft <= 0 && action.type === "ANALYZE_METHODS") {
      notes.push("ANALYZE_METHODS übersprungen — OpenAI-Budget erschöpft.");
      continue;
    }
    const targets = action.targets;
    const queryParts = [
      params.question,
      ...targets,
      action.reason,
    ].filter(Boolean);
    const query = queryParts.join(" ").slice(0, 500) || params.question;

    try {
      switch (action.type) {
        case "EXPAND_GRAPH": {
          const r = await KnowledgeRetriever.search({
            project: params.project,
            query,
            limit: 16,
            searchProfile: params.searchProfile,
            enableRelationExpansion: true,
          });
          hits.push(...r.hits);
          embedding_tokens += r.query_embedding_tokens;
          embedding_cost += r.query_embedding_cost;
          notes.push(
            `EXPAND_GRAPH: ${r.hits.length} Hits (targets=${targets.slice(0, 4).join(",") || "—"})`,
          );
          break;
        }
        case "SEARCH_CONFIG": {
          const r = await searchTyped({
            project: params.project,
            query,
            searchProfile: params.searchProfile,
            types: [
              "control_table",
              "control_table_analysis",
              "canonical_table_row",
              "business_rule",
            ],
            limit: 14,
          });
          hits.push(...r.hits);
          embedding_tokens += r.embedding_tokens;
          embedding_cost += r.embedding_cost;
          notes.push(`SEARCH_CONFIG: ${r.hits.length} Hits`);
          break;
        }
        case "SEARCH_DDIC": {
          const r = await searchTyped({
            project: params.project,
            query,
            searchProfile: params.searchProfile,
            types: [
              "table_profile",
              "ddic",
              "data_element",
              "domain",
              "structure",
            ],
            limit: 12,
          });
          hits.push(...r.hits);
          embedding_tokens += r.embedding_tokens;
          embedding_cost += r.embedding_cost;
          notes.push(`SEARCH_DDIC: ${r.hits.length} Hits (kein Export)`);
          break;
        }
        case "SEARCH_MASTERDATA": {
          const r = await searchTyped({
            project: params.project,
            query,
            searchProfile: params.searchProfile,
            types: [
              "customer_entity",
              "vendor_entity",
              "material_text",
              "master_data",
              "canonical_table_row",
            ],
            limit: 14,
          });
          hits.push(...r.hits);
          embedding_tokens += r.embedding_tokens;
          embedding_cost += r.embedding_cost;
          notes.push(`SEARCH_MASTERDATA: ${r.hits.length} Hits`);
          break;
        }
        case "SEARCH_CODE": {
          const r = await KnowledgeRetriever.search({
            project: params.project,
            query,
            limit: 18,
            searchProfile: params.searchProfile,
            enableRelationExpansion: true,
            filters: {
              knowledge_unit_types: [
                "code_unit",
                "code_unit_analysis",
                "program",
                "function_module",
              ],
            },
          });
          hits.push(...r.hits);
          embedding_tokens += r.query_embedding_tokens;
          embedding_cost += r.query_embedding_cost;
          notes.push(`SEARCH_CODE: ${r.hits.length} Hits`);
          break;
        }
        case "ANALYZE_METHODS": {
          if (analysesLeft <= 0) {
            notes.push("ANALYZE_METHODS übersprungen — Analyses-Budget erschöpft.");
            break;
          }
          const units = resolveMethodTargets(projectKey, targets);
          if (units.length === 0) {
            // Fallback: search code then skip analysis if no resolve
            const r = await KnowledgeRetriever.search({
              project: params.project,
              query,
              limit: 10,
              searchProfile: params.searchProfile,
              enableRelationExpansion: false,
              filters: {
                knowledge_unit_types: ["code_unit", "code_unit_analysis"],
              },
            });
            hits.push(...r.hits);
            notes.push(
              `ANALYZE_METHODS: keine auflösbaren Targets — Code-Suche ${r.hits.length}`,
            );
            break;
          }
          const abs = resolveWritablePath(
            projectKey,
            "analyses",
            "classes",
            "unit_analyses.jsonl",
          );
          const existing = existsSync(abs)
            ? parseUnitAnalysesJsonl(readFileSync(abs, "utf8"))
            : new Map<string, UnitAnalysisRecord>();
          const macros = loadMacros(projectKey);
          const provider = new OpenAIProvider();
          const written: UnitAnalysisRecord[] = [];
          for (const u of units) {
            if (analysesLeft <= 0 || openaiLeft <= 0) break;
            const result = await analyzeCodeUnit({
              unit: u,
              existing: existing.get(u.source_key),
              provider,
              knownMacros: macros,
            });
            if (result.ok && result.skipped) {
              continue;
            }
            openai_calls += 1;
            openaiLeft -= 1;
            if (result.ok) {
              written.push(result.record);
              existing.set(u.source_key, result.record);
              new_analyses.push(u.source_key);
              analysesLeft -= 1;
            }
          }
          if (written.length > 0) {
            persistAnalyses(projectKey, written);
            try {
              await syncClassAnalysesToHybrid({
                projectKey,
                batchSize: Math.max(written.length, 10),
                dryRun: false,
                prioritize: written.map((r) => r.source_key),
                systemId,
              });
            } catch (e) {
              notes.push(
                `ANALYZE_METHODS Sync: ${e instanceof Error ? e.message : "fehler"}`,
              );
            }
          }
          notes.push(
            `ANALYZE_METHODS: neu=${written.length} targets_resolved=${units.length}`,
          );
          break;
        }
        default:
          notes.push(`Unbekannte Action ignoriert.`);
      }
    } catch (e) {
      notes.push(
        `${action.type} fehlgeschlagen: ${e instanceof Error ? e.message : "unbekannt"}`,
      );
    }
  }

  return {
    hits,
    new_analyses,
    openai_calls,
    embedding_tokens,
    embedding_cost,
    notes,
  };
}
