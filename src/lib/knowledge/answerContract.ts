/**
 * Answer Contract: classify / align statements by evidence strength.
 * Post-processes LLM output — demotes unverifiable "confirmed" claims.
 */

import type { KnowledgeHit } from "@/lib/knowledge/knowledgeRetriever";
import type {
  ClassifiedStatement,
  EvidenceLevel,
  LlmAnswerPayload,
  ProcessAnswer,
  TechnicalAnswer,
} from "@/lib/knowledge/answerSchema";
import {
  EMPTY_PROCESS_ANSWER,
  EMPTY_TECHNICAL_ANSWER,
} from "@/lib/knowledge/answerSchema";
import type { QuestionIntentResult } from "@/lib/knowledge/questionIntent";
import { detectComparisonSides } from "@/lib/knowledge/questionIntent";

/** Business-purpose claims that must never be "confirmed" without explicit FACT text. */
const OVERCLAIM_RE =
  /\b(geschäftszweck|geschaeftszweck|organisationsziel|prozessoptimierung|falsche\s+bestellung|segmentierung|interne\s+steuerung|kundenarchitektur|bessere\s+unterscheidung|sortierprozess|steuerungszweck|vollst[äa]ndig\s+dokumentiert)\b/i;

const INFERRED_MARKERS_RE =
  /\b(vermutlich|deutet\s+darauf|könnte|koennte|wahrscheinlich|möglicherweise|moeglicherweise|scheint|interpretation|anzunehmen)\b/i;

const NO_PROCESS_MSG =
  "Der technische Mechanismus ist teilweise belegt; der vollständige fachliche Hintergrund ist in den Quellen nicht dokumentiert. Es wurde keine Prozessantwort erfunden.";

type LlmStatement = {
  text: string;
  level: "confirmed" | "inferred" | "possible";
  source_ranks: number[];
};

function rankToSourceId(
  rank: number,
  hits: KnowledgeHit[],
): string | undefined {
  return hits.find((h) => h.rank === rank)?.source_key;
}

function evidenceBlobForRanks(ranks: number[], hits: KnowledgeHit[]): string {
  const set = new Set(ranks);
  return hits
    .filter((h) => set.has(h.rank))
    .map((h) =>
      [
        h.title,
        h.snippet,
        h.technical_summary,
        h.business_purpose,
        ...(h.facts ?? []),
        ...(h.inferences ?? []),
        ...(h.evidence ?? []).map((e) => e.text ?? ""),
        ...(h.hardcoded_values ?? []),
      ].join("\n"),
    )
    .join("\n")
    .toLowerCase();
}

/** Tokenize claim for loose source containment check. */
function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[„“"'`]/g, "")
    .split(/[^a-z0-9äöüß_]+/i)
    .filter((t) => t.length >= 4)
    .filter(
      (t) =>
        ![
          "dass",
          "diese",
          "dieser",
          "einem",
          "einer",
          "werden",
          "wurde",
          "wenn",
          "dann",
          "oder",
          "auch",
          "nach",
          "über",
          "ueber",
          "durch",
          "liegt",
          "gibt",
          "nicht",
        ].includes(t),
    );
}

function claimSupportedBySources(
  text: string,
  ranks: number[],
  hits: KnowledgeHit[],
): boolean {
  if (ranks.length === 0) return false;
  const blob = evidenceBlobForRanks(ranks, hits);
  if (!blob.trim()) return false;
  const tokens = significantTokens(text);
  if (tokens.length === 0) return true;
  // Require at least ~40% of significant tokens OR a strong technical id hit
  const techIds = text.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [];
  if (techIds.length > 0) {
    const idHits = techIds.filter((id) => blob.includes(id.toLowerCase()));
    if (idHits.length >= Math.ceil(techIds.length * 0.5)) return true;
  }
  const hitCount = tokens.filter((t) => blob.includes(t)).length;
  return hitCount >= Math.max(1, Math.ceil(tokens.length * 0.4));
}

function normalizeLevel(
  stmt: LlmStatement,
  hits: KnowledgeHit[],
): ClassifiedStatement {
  const text = stmt.text.trim();
  let level: EvidenceLevel = stmt.level;
  const ranks = [...new Set(stmt.source_ranks)].filter((n) => n > 0);
  const source_ids = ranks
    .map((r) => rankToSourceId(r, hits))
    .filter((x): x is string => Boolean(x));

  if (!text) {
    return { text: "", level: "not_supported", source_ranks: [], source_ids: [] };
  }

  // Linguistic markers force inferred
  if (level === "confirmed" && INFERRED_MARKERS_RE.test(text)) {
    level = "inferred";
  }

  // Business overclaims never confirmed
  if (level === "confirmed" && OVERCLAIM_RE.test(text)) {
    level = "inferred";
  }

  if (level === "confirmed") {
    if (ranks.length === 0 || !claimSupportedBySources(text, ranks, hits)) {
      // Unverifiable "confirmed" → demote or drop from positive
      if (ranks.length > 0) {
        level = "inferred";
      } else {
        level = "not_supported";
      }
    }
  }

  if (level === "possible") {
    // possible only under Offen in process answer
  }

  return {
    text,
    level,
    source_ranks: ranks,
    source_ids,
  };
}

function partitionProcessStatements(
  statements: ClassifiedStatement[],
  openItems: string[],
): Pick<ProcessAnswer, "confirmed" | "inferred" | "open"> {
  const confirmed: ClassifiedStatement[] = [];
  const inferred: ClassifiedStatement[] = [];
  const open: ClassifiedStatement[] = [];

  for (const s of statements) {
    if (!s.text) continue;
    if (s.level === "confirmed") confirmed.push({ ...s, level: "confirmed" });
    else if (s.level === "inferred") inferred.push({ ...s, level: "inferred" });
    else if (s.level === "possible")
      open.push({ ...s, level: "possible" });
    else if (s.level === "not_supported" || s.level === "contradicted")
      open.push({
        ...s,
        level: s.level,
        text:
          s.level === "contradicted"
            ? `Widerspruch / nicht übertragbar: ${s.text}`
            : `Nicht belegt: ${s.text}`,
      });
  }

  for (const item of openItems) {
    const t = item.trim();
    if (!t) continue;
    open.push({
      text: t,
      level: "possible",
      source_ranks: [],
      source_ids: [],
    });
  }

  return { confirmed, inferred, open };
}

function joinTexts(stmts: ClassifiedStatement[], max = 3): string {
  return stmts
    .slice(0, max)
    .map((s) => s.text)
    .filter(Boolean)
    .join(" ");
}

function mapTechSection(
  stmts: LlmStatement[] | undefined,
  hits: KnowledgeHit[],
): ClassifiedStatement[] {
  return (stmts ?? [])
    .map((s) => normalizeLevel(s, hits))
    .filter((s) => s.text && s.level !== "not_supported");
}

/**
 * Build ProcessAnswer + TechnicalAnswer from LLM payload + hits.
 */
export function buildAnswerContract(params: {
  llm: LlmAnswerPayload;
  hits: KnowledgeHit[];
  intent: QuestionIntentResult;
  forceInsufficient?: boolean;
  insufficientMessage?: string;
}): {
  process_answer: ProcessAnswer;
  technical_answer: TechnicalAnswer;
  source_ranks_used: number[];
} {
  const { llm, hits, intent } = params;

  if (params.forceInsufficient) {
    const msg =
      params.insufficientMessage?.trim() ||
      "Im aktuell indexierten Wissensbestand nicht belastbar beantwortbar.";
    return {
      process_answer: {
        ...EMPTY_PROCESS_ANSWER,
        direct_answer: msg,
        has_safe_process_claim: false,
        no_process_claim_message: NO_PROCESS_MSG,
        open: [
          {
            text: msg,
            level: "not_supported",
            source_ranks: [],
            source_ids: [],
          },
        ],
        open_validation_questions: [msg],
      },
      technical_answer: { ...EMPTY_TECHNICAL_ANSWER },
      source_ranks_used: [],
    };
  }

  const normalized = (llm.process_answer.statements ?? []).map((s) =>
    normalizeLevel(s, hits),
  );
  const parts = partitionProcessStatements(
    normalized,
    llm.process_answer.open_items ?? [],
  );

  // Comparison honesty
  if (intent.preferences.require_both_comparison_sides) {
    const sidesInHits = detectComparisonSides(
      hits.map(
        (h) => `${h.title} ${h.source_key} ${h.object_name} ${h.subobject_name}`,
      ),
    );
    const ansBlob = [
      llm.process_answer.summary,
      ...normalized.map((s) => s.text),
    ].join("\n");
    const sidesInAns = detectComparisonSides([ansBlob]);
    if (sidesInHits.has_alt && sidesInHits.has_neu) {
      if (!sidesInAns.has_alt || !sidesInAns.has_neu) {
        parts.open.push({
          text: "Vergleich: im Wissensbestand sind beide Seiten (alt/neu) vertreten — die Antwort muss beide berücksichtigen; fehlende Seite hier nachziehen bzw. offen markieren.",
          level: "possible",
          source_ranks: [],
          source_ids: [],
        });
      }
    } else if (sidesInHits.has_alt !== sidesInHits.has_neu) {
      parts.open.push({
        text: `Vergleich unvollständig belegt: nur ${sidesInHits.has_alt ? "alt" : "neu"}-Seite in den Treffern — die andere Seite ist nicht dokumentiert.`,
        level: "possible",
        source_ranks: [],
        source_ids: [],
      });
    }
  }

  const has_safe_process_claim =
    Boolean(llm.process_answer.has_safe_process_claim) &&
    parts.confirmed.length > 0;

  let summary =
    llm.process_answer.summary.trim() ||
    joinTexts(parts.confirmed, 2) ||
    (has_safe_process_claim ? "" : NO_PROCESS_MSG);

  // Purpose/optimization phrasing in the lead summary → demote to inferred
  if (summary && OVERCLAIM_RE.test(summary)) {
    parts.inferred.push({
      text: INFERRED_MARKERS_RE.test(summary)
        ? summary
        : `Abgeleitet: ${summary}`,
      level: "inferred",
      source_ranks: [],
      source_ids: [],
    });
    summary =
      joinTexts(parts.confirmed, 2) ||
      "Technischer Mechanismus teilweise belegt; fachlicher Zweck nicht als Fakt dokumentiert.";
  } else if (summary) {
    const purposeSplit = summary.match(
      /^(.*?)(?:\.\s*|\s+)(Dies dient\b.*)$/i,
    );
    if (purposeSplit?.[1]?.trim() && purposeSplit[2]?.trim()) {
      parts.inferred.push({
        text: `Abgeleitet: ${purposeSplit[2].trim()}`,
        level: "inferred",
        source_ranks: [],
        source_ids: [],
      });
      summary = purposeSplit[1].trim().replace(/\.$/, "") + ".";
    }
  }

  // If model claimed safe process but nothing survived as confirmed → no invent
  const finalSafe = has_safe_process_claim && parts.confirmed.length > 0;

  const process_answer: ProcessAnswer = {
    direct_answer: finalSafe
      ? summary
      : summary || NO_PROCESS_MSG,
    special_process: joinTexts(parts.confirmed, 2),
    trigger: "",
    process_effect: joinTexts(
      parts.confirmed.filter((s) =>
        /setzt|weist|ändert|aendert|schreibt|kennzeich/i.test(s.text),
      ),
      2,
    ),
    business_interpretation: joinTexts(parts.inferred, 3),
    open_validation_questions: parts.open.map((s) => s.text),
    confirmed: parts.confirmed,
    inferred: parts.inferred.map((s) => ({
      ...s,
      text: /^(abgeleitet:|vermutlich\b|das deutet)/i.test(s.text.trim())
        ? s.text
        : `Abgeleitet: ${s.text}`,
    })),
    open: parts.open,
    has_safe_process_claim: finalSafe,
    no_process_claim_message: finalSafe ? "" : NO_PROCESS_MSG,
  };

  const ta = llm.technical_answer ?? {};
  const technical_answer: TechnicalAnswer = {
    entry_point: mapTechSection(ta.entry_point, hits),
    trigger: mapTechSection(ta.trigger, hits),
    processing: mapTechSection(ta.processing, hits),
    objects: mapTechSection(ta.objects, hits),
    results: mapTechSection(ta.results, hits),
    relations: mapTechSection(ta.relations, hits),
    open: mapTechSection(ta.open, hits),
  };

  // Fill process trigger from technical if empty
  if (!process_answer.trigger && technical_answer.trigger.length) {
    process_answer.trigger = joinTexts(
      technical_answer.trigger.filter((s) => s.level === "confirmed"),
      2,
    );
  }

  const ranksFromProcess = [
    ...parts.confirmed,
    ...parts.inferred,
  ].flatMap((s) => s.source_ranks);
  const ranksFromTech = Object.values(technical_answer)
    .flat()
    .flatMap((s) => s.source_ranks);
  const source_ranks_used = [
    ...new Set([
      ...(llm.source_ranks_used ?? []),
      ...ranksFromProcess,
      ...ranksFromTech,
    ]),
  ].filter((n) => n > 0);

  return { process_answer, technical_answer, source_ranks_used };
}

/** Seed technical answer sections from deterministic hit extraction when LLM is thin. */
export function enrichTechnicalAnswerFromHits(
  tech: TechnicalAnswer,
  hits: KnowledgeHit[],
): TechnicalAnswer {
  const out: TechnicalAnswer = {
    entry_point: [...tech.entry_point],
    trigger: [...tech.trigger],
    processing: [...tech.processing],
    objects: [...tech.objects],
    results: [...tech.results],
    relations: [...tech.relations],
    open: [...tech.open],
  };

  if (out.entry_point.length === 0) {
    for (const h of hits.slice(0, 3)) {
      const label = [h.object_type, h.object_name, h.subobject_name]
        .filter(Boolean)
        .join(" / ");
      if (!label) continue;
      out.entry_point.push({
        text: label,
        level: "confirmed",
        source_ranks: [h.rank],
        source_ids: [h.source_key],
      });
    }
  }

  if (out.objects.length === 0) {
    for (const h of hits.slice(0, 5)) {
      for (const m of (h.called_methods ?? []).slice(0, 3)) {
        out.objects.push({
          text: m,
          level: "confirmed",
          source_ranks: [h.rank],
          source_ids: [h.source_key],
        });
      }
    }
  }

  if (out.results.length === 0) {
    for (const h of hits.slice(0, 3)) {
      for (const v of (h.hardcoded_values ?? []).slice(0, 6)) {
        out.results.push({
          text: `Hardcoding/Wert: ${v}`,
          level: "confirmed",
          source_ranks: [h.rank],
          source_ids: [h.source_key],
        });
      }
    }
  }

  // Surface short coded hardcodings even when LLM wrote prose without quoting them
  const resultBlob = out.results.map((s) => s.text).join(" ");
  for (const h of hits.slice(0, 4)) {
    for (const v of (h.hardcoded_values ?? []).slice(0, 12)) {
      const bare = v.replace(/^'|'$/g, "");
      if (!bare || bare.length > 12) continue;
      // Generic coded literals: short uppercase/digit tokens (not customer-specific names)
      if (!/^[A-Z0-9_]{1,12}$/i.test(bare)) continue;
      if (bare.length < 1) continue;
      if (new RegExp(bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(resultBlob)) {
        continue;
      }
      out.results.push({
        text: `Belegter Wert: ${v}`,
        level: "confirmed",
        source_ranks: [h.rank],
        source_ids: [h.source_key],
      });
    }
  }

  if (out.relations.length === 0) {
    for (const h of hits.slice(0, 4)) {
      for (const t of (h.tables_read ?? []).slice(0, 3)) {
        out.relations.push({
          text: `READ ${t}`,
          level: "confirmed",
          source_ranks: [h.rank],
          source_ids: [h.source_key],
        });
      }
      for (const t of (h.tables_written ?? []).slice(0, 2)) {
        out.relations.push({
          text: `WRITE ${t}`,
          level: "confirmed",
          source_ranks: [h.rank],
          source_ids: [h.source_key],
        });
      }
    }
  }

  return out;
}

export const ANSWER_CONTRACT_NO_PROCESS_MSG = NO_PROCESS_MSG;
