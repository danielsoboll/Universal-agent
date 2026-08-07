/**
 * Generische Code-Expansion: Primäranker-Tokens (Feld-/Tabellennamen)
 * in Canonical-code_units.source_code finden und als Evidence-Hits liefern.
 * Kein Index-Rebuild, keine Analyse-Wiederholung.
 */
import { existsSync, readFileSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import type { KnowledgeHit } from "@/lib/knowledge/types";

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseUnitNames(sourceKey: string, rec: Record<string, unknown>) {
  const parts = sourceKey.split("|").map((p) => p.trim()).filter(Boolean);
  const methodIdx = parts.findIndex((p) => p.toUpperCase() === "METHOD");
  const formIdx = parts.findIndex((p) => p.toUpperCase() === "FORM");
  const classIdx = parts.findIndex((p) => p.toUpperCase() === "CLASS");
  const progIdx = parts.findIndex((p) => p.toUpperCase() === "PROG" || p.toUpperCase() === "PROGRAM");
  const fmIdx = parts.findIndex((p) => p.toUpperCase() === "FUGR" || p.toUpperCase() === "FUNC");

  const method =
    asString(rec.method_name) ||
    asString(rec.subobject_name) ||
    (methodIdx >= 0 ? parts[methodIdx + 1] ?? "" : "") ||
    (formIdx >= 0 ? parts[formIdx + 1] ?? "" : "");
  const object =
    asString(rec.object_name) ||
    asString(rec.class_name) ||
    (classIdx >= 0 ? parts[classIdx + 1] ?? "" : "") ||
    (progIdx >= 0 ? parts[progIdx + 1] ?? "" : "") ||
    (fmIdx >= 0 ? parts[fmIdx + 1] ?? "" : "");
  return { object, method };
}

function snippetAround(source: string, needle: string, radius = 480): string {
  const upper = source.toUpperCase();
  const n = needle.toUpperCase();
  const i = upper.indexOf(n);
  if (i < 0) return source.slice(0, radius * 2);
  let start = Math.max(0, i - radius);
  let end = Math.min(source.length, i + n.length + radius);
  // Prefer line boundaries for readable evidence
  const before = source.lastIndexOf("\n", i);
  if (before >= 0 && i - before < radius + 120) start = before + 1;
  const after = source.indexOf("\n", i + n.length);
  if (after >= 0 && after - i < radius + 120) end = Math.min(source.length, after);
  // Include a couple of neighboring lines when short
  if (end - start < 120) {
    const prev = source.lastIndexOf("\n", start - 2);
    const next = source.indexOf("\n", end + 1);
    if (prev >= 0) start = prev + 1;
    if (next >= 0) end = next;
  }
  return source.slice(start, end).replace(/\s+/g, " ").trim();
}

function hitFromCodeRec(params: {
  sourceKey: string;
  rec: Record<string, unknown>;
  token: string;
  zone: string;
  rank: number;
}): KnowledgeHit {
  const { object, method } = parseUnitNames(params.sourceKey, params.rec);
  const source = asString(params.rec.source_code);
  const snip = snippetAround(source, params.token);
  const title = [object, method].filter(Boolean).join(" / ") || params.sourceKey;
  const id = `canonical-code:${params.sourceKey}`;
  return {
    rank: params.rank,
    search_document_id: id,
    source_key: params.sourceKey,
    title,
    knowledge_unit_type: "code_unit",
    combined_score: 55 + Math.min(20, params.token.length),
    exact_score: 2,
    fulltext_score: 5,
    vector_score: 0,
    metadata_score: 1,
    confidence_bonus: 0.3,
    confidence: 0.7,
    matched_terms: [`code_ref:${params.token}`],
    snippet: snip.slice(0, 700),
    evidence_refs: [`${params.zone}:${params.sourceKey}`],
    facts: [
      `Code referenziert ${params.token}`,
      object ? `Objekt: ${object}` : "",
      method ? `Routine: ${method}` : "",
      `Zone: ${params.zone}`,
    ].filter(Boolean),
    inferences: [],
    metadata: {
      lexical_expand: "code_usage",
      matched_token: params.token,
      zone: params.zone,
    },
    object_name: object,
    object_type: "CODE_UNIT",
    subobject_name: method,
    technical_summary: snip.slice(0, 900),
    business_purpose: "",
    tables_read: [],
    tables_written: [],
    called_methods: [],
    called_functions: [],
    hardcoded_values: [params.token],
    entities: [],
    relations: [],
    evidence: [
      {
        statement_type: "fact",
        text: `Referenz auf ${params.token}`,
        lines: [{ quote: snip.slice(0, 500) }],
      },
    ],
    doc_confidence: 0.7,
  };
}

/**
 * Scan canonical code_units for technical tokens (fields, Z-tables).
 * Returns deduped KnowledgeHits with source snippets.
 */
export function expandCodeUsagesFromCanonical(params: {
  projectKey: string;
  tokens: string[];
  /** Optional content stems from the question (e.g. virtuell, lager) for class-name boosting. */
  contentStems?: string[];
  limit?: number;
  alreadySeen?: Set<string>;
}): KnowledgeHit[] {
  const limit = params.limit ?? 8;
  const needles = [
    ...new Set(
      params.tokens
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t.length >= 4 && (t.includes("_") || /^[ZY]/.test(t) || t.includes("-"))),
    ),
  ];
  if (needles.length === 0) return [];

  const stems = (params.contentStems ?? [])
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 5);

  const zones = ["classes", "programs", "function-modules"] as const;
  const seen = new Set(params.alreadySeen ?? []);
  const scored: Array<{ hit: KnowledgeHit; score: number; object: string }> = [];
  /** Full records of process-relevant classes for sibling expansion */
  const classRecords = new Map<string, Array<Record<string, unknown>>>();

  const scoreHit = (hit: KnowledgeHit, matched: string): number => {
    let score = matched.length;
    const snip = hit.snippet;
    if (/\bIF\b|\bCASE\b|\bEQ\b|\bNE\b|ABAP_TRUE|ABGRU|AUART|IN @/i.test(snip)) {
      score += 25;
    }
    if (/Monitor|Absage|Auftrag|Filter|virtuell|Confirm|Verpack/i.test(snip)) {
      score += 12;
    }
    if (/SELECT[\s\S]{0,80}AS\s+ZVLAGER/i.test(snip) && !/\bIF\b/i.test(snip)) {
      score -= 15;
    }
    if (hit.subobject_name) score += 5;
    if (/^ZCL_/i.test(hit.object_name)) score += 3;
    const objFold = hit.object_name.toLowerCase();
    const methFold = (hit.subobject_name || "").toLowerCase();
    if (stems.some((s) => objFold.includes(s) || methFold.includes(s))) {
      score += 45;
    }
    if (/VIRTUELL|VLAGER/i.test(hit.object_name) || /VIRTUELL|VLAGER/i.test(hit.subobject_name)) {
      score += 20;
    }
    return score;
  };

  for (const zone of zones) {
    let path: string;
    try {
      path = resolveProjectZonePath(
        params.projectKey,
        "canonical",
        zone,
        "code_units.jsonl",
      );
    } catch {
      continue;
    }
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const sourceKey = asString(rec.source_key);
      if (!sourceKey) continue;
      const { object } = parseUnitNames(sourceKey, rec);
      if (object) {
        const list = classRecords.get(object) ?? [];
        list.push(rec);
        classRecords.set(object, list);
      }

      const upperLine = line.toUpperCase();
      let matched = "";
      for (const n of needles) {
        if (upperLine.includes(n)) {
          matched = n;
          break;
        }
      }
      if (!matched) continue;
      if (seen.has(sourceKey)) continue;
      const src = asString(rec.source_code);
      if (!src.toUpperCase().includes(matched)) continue;

      seen.add(sourceKey);
      const hit = hitFromCodeRec({
        sourceKey,
        rec,
        token: matched,
        zone,
        rank: 0,
      });
      scored.push({ hit, score: scoreHit(hit, matched), object: hit.object_name });
    }
  }

  // Sibling methods of process classes (name matches question stems / VLAGER)
  const processClasses = new Set(
    scored
      .filter((s) => s.score >= 40)
      .map((s) => s.object)
      .filter((o) => {
        const fold = o.toLowerCase();
        return (
          stems.some((st) => fold.includes(st)) ||
          /VIRTUELL|VLAGER/i.test(o)
        );
      }),
  );

  for (const cls of processClasses) {
    for (const rec of classRecords.get(cls) ?? []) {
      const sourceKey = asString(rec.source_key);
      if (!sourceKey || seen.has(sourceKey)) continue;
      const src = asString(rec.source_code);
      const { method } = parseUnitNames(sourceKey, rec);
      const methOk =
        /VLAGER|VIRTUELL|CONFIRM|ABGRU|DELIVERY|CHECK|CHANGE_/i.test(method) ||
        src.length >= 400;
      if (!methOk || src.length < 80) continue;
      seen.add(sourceKey);
      const token =
        needles.find((n) => src.toUpperCase().includes(n)) ?? needles[0]!;
      const hit = hitFromCodeRec({
        sourceKey,
        rec,
        token,
        zone: "classes",
        rank: 0,
      });
      // Sibling without direct token still useful if method name is process-like
      const bonus = /VLAGER|VIRTUELL/i.test(method) ? 30 : 10;
      scored.push({
        hit,
        score: scoreHit(hit, token) + bonus,
        object: cls,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s, i) => ({ ...s.hit, rank: i + 1 }));
}
