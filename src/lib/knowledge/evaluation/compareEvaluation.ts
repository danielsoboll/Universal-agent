/**
 * Compare ground truth vs retrieval / evidence / answer.
 * Generic — no per-symbol production rules.
 */
import type { GroundTruthInventory } from "./groundTruthInventory";

export type GapCause =
  | "SOURCE_MISSING"
  | "CANONICAL_MISSING"
  | "INDEX_MISSING"
  | "EXACT_SEARCH_MISS"
  | "SEMANTIC_SEARCH_MISS"
  | "RELATION_MISSING"
  | "RANKING_ERROR"
  | "EVIDENCE_FILTERED_OUT"
  | "TOKEN_LIMIT_TRUNCATION"
  | "OPENAI_IGNORED_EVIDENCE"
  | "OPENAI_MISINTERPRETED_EVIDENCE"
  | "ANSWER_PROMPT_ERROR";

export type ClassifiedGap = {
  kind: "entity" | "relation" | "claim";
  id: string;
  cause: GapCause;
  detail: string;
};

export type EvaluationReport = {
  anchor: string;
  question: string;
  generated_at: string;
  ground_truth_entity_count: number;
  retrieved_entity_count: number;
  evidence_entity_count: number;
  answer_entity_count: number;
  retrieval_recall: number;
  evidence_recall: number;
  critical_entities_missing: string[];
  critical_relations_missing: string[];
  retrieved_but_discarded: string[];
  passed_to_openai_but_unused: string[];
  unsupported_answer_claims: string[];
  incorrect_object_classifications: string[];
  conflicts: string[];
  classified_gaps: ClassifiedGap[];
  metrics: Record<string, number | string | boolean>;
  pass: boolean;
};

function normId(s: string): string {
  return s.trim().toUpperCase();
}

function keysMatch(a: string, b: string): boolean {
  const A = normId(a);
  const B = normId(b);
  if (A === B) return true;
  const aId = A.includes(":") ? A.split(":").slice(1).join(":") : A;
  const bId = B.includes(":") ? B.split(":").slice(1).join(":") : B;
  if (aId === bId) return true;
  // B|V1|ZECD vs ZECD / OUTPUT_TYPE:ZECD
  if (aId.endsWith(`|${bId}`) || bId.endsWith(`|${aId}`)) return true;
  if (aId.endsWith(`.${bId}`) || bId.endsWith(`.${aId}`)) return true;
  return false;
}

function setHasKey(set: Set<string>, key: string): boolean {
  if (set.has(normId(key))) return true;
  for (const s of set) {
    if (keysMatch(s, key)) return true;
  }
  return false;
}

function extractMentionedIds(text: string, candidates: string[]): string[] {
  const u = text.toUpperCase();
  const found: string[] = [];
  for (const c of candidates) {
    const id = c.includes(":") ? c.split(":").slice(1).join(":") : c;
    const token = normId(id);
    if (token.length < 3) continue;
    if (u.includes(token)) found.push(c);
  }
  return found;
}

export function buildEvaluationReport(params: {
  groundTruth: GroundTruthInventory;
  question: string;
  retrievedEntityKeys: string[];
  evidenceEntityKeys: string[];
  evidenceRelationKeys: string[];
  evidenceText: string;
  answerText: string;
  discardedEntityKeys?: string[];
  truncated?: boolean;
  metrics?: Record<string, number | string | boolean>;
}): EvaluationReport {
  const gt = params.groundTruth;
  const critical = gt.critical_entity_ids;
  const criticalRels = gt.critical_relation_keys;

  const retrieved = new Set(params.retrievedEntityKeys.map(normId));
  const evidence = new Set(params.evidenceEntityKeys.map(normId));
  const evidenceRels = new Set(params.evidenceRelationKeys.map(normId));

  const answerMentions = extractMentionedIds(
    params.answerText,
    critical,
  );

  const criticalMissing = critical.filter((c) => {
    if (setHasKey(evidence, c)) return false;
    const idPart = c.includes(":") ? c.split(":").slice(1).join(":") : c;
    const tokens = normId(idPart).split(/[.|]/).filter((t) => t.length >= 3);
    const blob = params.evidenceText.toUpperCase();
    // Soft cover when distinctive id tokens appear in evidence package text
    if (tokens.some((t) => t === normId(gt.anchor)) && tokens.length === 1) {
      return !blob.includes(normId(gt.anchor));
    }
    return !tokens.every((t) => blob.includes(t));
  });
  const criticalRelsMissing = criticalRels.filter(
    (r) => !evidenceRels.has(normId(r)) && !params.evidenceText.toUpperCase().includes(normId(r.split("|")[0] ?? "")),
  );

  // Soft critical-rel check: if both endpoints appear in evidence text, count as covered
  const softRelMissing = criticalRels.filter((r) => {
    const [from, , to] = r.split("|");
    const blob = params.evidenceText.toUpperCase();
    if (from && to && blob.includes(normId(from)) && blob.includes(normId(to))) {
      return false;
    }
    return !evidenceRels.has(normId(r));
  });

  const retrievedButDiscarded = params.retrievedEntityKeys.filter(
    (k) => !setHasKey(evidence, k),
  );

  const passedUnused = params.evidenceEntityKeys.filter(
    (k) => !params.answerText.toUpperCase().includes(normId(k.includes(":") ? k.split(":").slice(1).join(":") : k)),
  );

  // Unsupported claims: SAP-like Z/Y tokens with underscore (avoid German words like Zudem)
  const unsupported: string[] = [];
  const zTokens = params.answerText.match(/\b[ZY][A-Z0-9]*_[A-Z0-9_]{2,}\b/gi) ?? [];
  const evidenceU = params.evidenceText.toUpperCase();
  for (const t of zTokens) {
    if (!evidenceU.includes(t.toUpperCase())) {
      unsupported.push(`Answer mentions ${t} without evidence support`);
    }
  }

  const classified: ClassifiedGap[] = [];
  for (const c of criticalMissing) {
    const inRetrieved = [...retrieved].some(
      (r) =>
        r === normId(c) ||
        r.endsWith(`:${normId(c.split(":").slice(1).join(":"))}`) ||
        normId(c).includes(r.split(":").slice(1).join(":")),
    );
    const inGt = gt.entities.some((e) => {
      const k = `${e.type}:${e.id}`.toUpperCase();
      return k === normId(c) || k.endsWith(`:${normId(c.split(":").slice(1).join(":"))}`);
    });
    let cause: GapCause = "EXACT_SEARCH_MISS";
    if (!inGt) cause = "CANONICAL_MISSING";
    else if (inRetrieved) cause = "EVIDENCE_FILTERED_OUT";
    else if (params.truncated && inRetrieved) cause = "TOKEN_LIMIT_TRUNCATION";
    classified.push({
      kind: "entity",
      id: c,
      cause,
      detail: inRetrieved
        ? "In retrieval inventory but not in evidence package"
        : "Present in ground truth but not retrieved into inventory/graph",
    });
  }

  for (const r of softRelMissing.slice(0, 40)) {
    classified.push({
      kind: "relation",
      id: r,
      cause: "RELATION_MISSING",
      detail: "Critical relation not represented in evidence package",
    });
  }

  for (const u of unsupported.slice(0, 20)) {
    classified.push({
      kind: "claim",
      id: u,
      cause: "OPENAI_MISINTERPRETED_EVIDENCE",
      detail: u,
    });
  }

  // Evidence present but unused for critical config facts
  for (const c of critical) {
    if (!setHasKey(evidence, c)) continue;
    const idPart = c.includes(":") ? c.split(":").slice(1).join(":") : c;
    if (
      params.answerText &&
      !params.answerText.toUpperCase().includes(normId(idPart)) &&
      (c.startsWith("OUTPUT_TYPE") ||
        c.includes("PROGRAM") ||
        c.includes("FORM_ROUTINE"))
    ) {
      classified.push({
        kind: "entity",
        id: c,
        cause: "OPENAI_IGNORED_EVIDENCE",
        detail: "Critical entity in evidence but not reflected in answer",
      });
    }
  }

  const retrievalHits = critical.filter((c) => setHasKey(retrieved, c)).length;
  const evidenceHits = critical.filter((c) => setHasKey(evidence, c)).length;
  const retrieval_recall =
    critical.length === 0 ? 1 : retrievalHits / critical.length;
  const evidence_recall =
    critical.length === 0 ? 1 : evidenceHits / critical.length;

  const coreConfigPresent = [
    "OUTPUT_TYPE",
    "OUTPUT_TYPE_TEXT",
    "OUTPUT_PROCESSING",
  ].every((t) =>
    [...evidence].some((k) => k.startsWith(`${t}:`) || k.includes(`:${gt.anchor}`)),
  );

  // Pass criteria (soft): core message facts + no unsupported Z-claims + no ? as proven
  const hasUnsupported = unsupported.length > 0;
  const pass =
    evidence_recall >= 0.35 &&
    !hasUnsupported &&
    criticalMissing.filter((c) =>
      c.startsWith("OUTPUT_TYPE") ||
      c.includes("OUTPUT_PROCESSING") ||
      c.includes("OUTPUT_TYPE_TEXT"),
    ).length === 0;

  return {
    anchor: gt.anchor,
    question: params.question,
    generated_at: new Date().toISOString(),
    ground_truth_entity_count: gt.entities.length,
    retrieved_entity_count: params.retrievedEntityKeys.length,
    evidence_entity_count: params.evidenceEntityKeys.length,
    answer_entity_count: answerMentions.length,
    retrieval_recall: Number(retrieval_recall.toFixed(4)),
    evidence_recall: Number(evidence_recall.toFixed(4)),
    critical_entities_missing: criticalMissing,
    critical_relations_missing: softRelMissing.slice(0, 100),
    retrieved_but_discarded: [
      ...new Set([
        ...(params.discardedEntityKeys ?? []),
        ...retrievedButDiscarded,
      ]),
    ].slice(0, 200),
    passed_to_openai_but_unused: passedUnused.slice(0, 100),
    unsupported_answer_claims: unsupported,
    incorrect_object_classifications: [],
    conflicts: [],
    classified_gaps: classified,
    metrics: {
      critical_entity_count: critical.length,
      critical_relation_count: criticalRels.length,
      core_config_in_evidence: coreConfigPresent,
      truncated: Boolean(params.truncated),
      ...(params.metrics ?? {}),
    },
    pass,
  };
}
