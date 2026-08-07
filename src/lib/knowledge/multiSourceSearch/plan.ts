/**
 * Search plan: concepts + synonym candidates from the question.
 * Deterministic first; optional LLM synonym enrichment (no customer hardcoding).
 */
import OpenAI from "openai";
import { AI_CONFIG } from "@/lib/ai/config";
import type {
  MultiSourceId,
  MultiSourceSearchPlan,
} from "@/lib/knowledge/multiSourceSearch/types";
import {
  filterRetrievalConcepts,
  isQueryStopword,
} from "@/lib/knowledge/queryStopwords";

const DEFAULT_SOURCE_ORDER: MultiSourceId[] = [
  "exact_symbol",
  "master_data",
  "control_tables",
  "classes",
  "programs",
  "function_modules",
  "relations",
];

const DEFAULT_BUDGETS: Record<MultiSourceId, number> = {
  exact_symbol: 20,
  master_data: 8,
  control_tables: 14,
  classes: 10,
  programs: 10,
  function_modules: 8,
  relations: 6,
};

/** Generic DE/EN technical synonym map — domain language, not customer-specific. */
const GENERIC_SYNONYM_MAP: Record<string, string[]> = {
  lager: [
    "lager",
    "lagerort",
    "lgort",
    "warehouse",
    "storage",
    "stock",
    "bestand",
    "lgnum",
    "lgpla",
  ],
  virtuell: ["virtuell", "virtual", "pseudo"],
  material: ["material", "matnr", "artikel", "sku"],
  kunde: ["kunde", "customer", "kunnr", "debitor"],
  lieferant: ["lieferant", "vendor", "lifnr", "kreditor"],
  werk: ["werk", "werks", "plant"],
  steuerung: ["steuerung", "customizing", "control", "parameter"],
  klasse: ["klasse", "class", "method"],
  programm: ["programm", "program", "report"],
  funktionsbaustein: ["funktionsbaustein", "function", "fm", "bapi"],
};

function tokenizeQuestion(question: string): string[] {
  return question
    .split(/[^A-Za-zÄÖÜäöüß0-9_\/-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !isQueryStopword(t));
}

function expandGenericSynonyms(tokens: string[]): string[] {
  const out = new Set<string>();
  for (const token of tokens) {
    const lower = token.toLowerCase();
    out.add(token);
    out.add(lower);
    for (const [key, syns] of Object.entries(GENERIC_SYNONYM_MAP)) {
      if (lower.includes(key) || key.includes(lower)) {
        for (const s of syns) out.add(s);
      }
    }
    // Compound splits already handled by tokenizeQuestion
    if ((token.startsWith("Z") || token.startsWith("Y") || token.startsWith("z") || token.startsWith("y")) && token.length >= 3) {
      out.add(token.toUpperCase());
    }
  }
  return [...out];
}

/**
 * Build a multi-source search plan.
 * Does not hardcode customer names — only question tokens + generic SAP synonyms.
 */
export async function buildMultiSourceSearchPlan(params: {
  question: string;
  maxRounds?: number;
  enrichWithLlm?: boolean;
}): Promise<{
  plan: MultiSourceSearchPlan;
  llm_used: boolean;
  notes: string[];
}> {
  const notes: string[] = [];
  const tokens = tokenizeQuestion(params.question);
  const concepts = filterRetrievalConcepts(
    [...new Set(tokens.map((t) => t.toLowerCase()))],
  ).slice(0, 24);
  let synonym_candidates = expandGenericSynonyms(tokens).filter(
    (s) => !isQueryStopword(s),
  );
  let llm_used = false;

  if (params.enrichWithLlm !== false && process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: AI_CONFIG.timeoutMs,
        maxRetries: AI_CONFIG.maxRetries,
      });
      const completion = await client.chat.completions.create({
        model: AI_CONFIG.chatModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: [
              "Du erweiterst Suchbegriffe für eine SAP-Wissenssuche.",
              "Antworte NUR mit JSON: {\"synonyms\":[\"...\"]}.",
              "Liefere technische Synonyme und mögliche Feld-/Tabellen-Hinweise (z.B. LGORT, ZZ_*-Felder).",
              "Keine Kundennamen erfinden oder fest verdrahten.",
              "Maximal 30 Einträge.",
            ].join(" "),
          },
          {
            role: "user",
            content: `Frage: ${params.question}\nBereits: ${synonym_candidates.slice(0, 20).join(", ")}`,
          },
        ],
        response_format: { type: "json_object" },
      });
      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw) as { synonyms?: unknown };
      if (Array.isArray(parsed.synonyms)) {
        for (const s of parsed.synonyms) {
          if (typeof s === "string" && s.trim().length >= 2) {
            synonym_candidates.push(s.trim());
          }
        }
        llm_used = true;
        notes.push("Synonyme per LLM angereichert.");
      }
    } catch (e) {
      notes.push(
        `LLM-Synonym-Anreicherung übersprungen: ${e instanceof Error ? e.message : "error"}`,
      );
    }
  } else {
    notes.push("Nur deterministische Synonyme (kein LLM).");
  }

  synonym_candidates = [
    ...new Set(synonym_candidates.map((s) => s.trim()).filter(Boolean)),
  ].slice(0, 48);

  const plan: MultiSourceSearchPlan = {
    version: "multi-source-plan-v1",
    question: params.question.trim(),
    concepts,
    synonym_candidates,
    source_order: [...DEFAULT_SOURCE_ORDER],
    max_rounds: params.maxRounds ?? 2,
    budgets: { ...DEFAULT_BUDGETS },
    notes,
  };

  return { plan, llm_used, notes };
}

export function anchorKey(kind: string, value: string): string {
  return `${kind}:${value.trim().toUpperCase()}`;
}
