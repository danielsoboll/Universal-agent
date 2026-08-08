/**
 * Final user-facing evidence / claim deduplication.
 * Retrieval may keep multiple near-duplicate hits; the answer context should not.
 *
 * Merges by canonical technical identity — not by raw display string alone.
 * Does not merge fachlich different objects (e.g. different partner-profile keys).
 */
import type { KnowledgeHit } from "@/lib/knowledge/types";

function upper(s: string): string {
  return s.trim().toUpperCase();
}

function lower(s: string): string {
  return s.trim().toLowerCase();
}

function isCodeFamily(hit: KnowledgeHit): boolean {
  const ot = lower(hit.object_type ?? "");
  const kut = lower(hit.knowledge_unit_type ?? "");
  if (kut === "code_unit") return true;
  return (
    ot === "program" ||
    ot === "code_unit" ||
    ot === "class" ||
    ot === "function" ||
    ot === "function_module" ||
    ot === "method" ||
    ot === "include"
  );
}

/**
 * Canonical identity for final-context dedup.
 * Same identity → keep strongest hit; aggregate sibling source ids.
 *
 * Literals, FORM/METHOD routines, and program-level units must stay distinct
 * even when they share the same program object_name.
 */
export function canonicalEvidenceIdentity(hit: KnowledgeHit): string {
  const ot = lower(hit.object_type ?? "");
  const kut = lower(hit.knowledge_unit_type ?? "");
  const name = upper(hit.object_name ?? "");
  const sub = upper(hit.subobject_name ?? "");
  const sourceKey = upper(hit.source_key ?? "");

  // Literals first — never collapse into program/FORM code units.
  if (
    hit.metadata?.portable_literal === true ||
    String(hit.search_document_id ?? "").startsWith("literal:")
  ) {
    const lit = upper(
      String(
        hit.hardcoded_values?.[0] ??
          hit.metadata?.literal_id ??
          hit.snippet ??
          "",
      ),
    );
    const bound = Array.isArray(hit.metadata?.bound_fields)
      ? upper(String((hit.metadata!.bound_fields as unknown[])[0] ?? ""))
      : "";
    const claim = literalClaimType(hit, bound);
    return `literal|${name}|${lit}|${claim}`;
  }

  if (isCodeFamily(hit)) {
    const routine = sub || extractRoutineIdentifier(hit);
    if (routine) {
      const kind = routineKindFromHit(hit, routine);
      return `code|${name}|${kind}|${routine}`;
    }
    // Program/class-level unit without routine — normalize PROGRAM/CODE_UNIT.
    return `code|${name}|UNIT|ROOT`;
  }

  if (kut === "message_idoc_object" || ot.includes("partner") || ot.includes("logical") || ot.includes("output") || ot.includes("idoc") || ot.includes("message")) {
    // Keep full technical id — LS|OCTOPUS ≠ LS|OCTOPUS|ZCSVFILE.
    const id = name || sourceKey || upper(hit.title ?? "");
    return `msg|${ot || kut}|${id}`;
  }

  if (kut === "master_field" || ot === "enrichment") {
    const seed =
      String(hit.metadata?.enrichment_seed ?? hit.source_key ?? name).toUpperCase();
    return `field|${seed}`;
  }

  if (kut === "table_profile" || ot === "table") {
    return `table_profile|${name}`;
  }

  if (kut === "table_row" || ot === "table_row") {
    // Rows differ by content — use title/source_key, not only table name.
    return `table_row|${name}|${sourceKey || upper(hit.title ?? "")}`;
  }

  // Fallback: type + object + source_key (stable, conservative — rarely merges).
  return `doc|${kut || ot}|${name}|${sourceKey || hit.search_document_id}`;
}

/** kschl='ZRAH' vs bare literal value — same value, different claims stay separate only by field. */
function literalClaimType(hit: KnowledgeHit, boundField: string): string {
  if (boundField) return `FIELD:${boundField}`;
  const preview = `${hit.snippet ?? ""} ${hit.technical_summary ?? ""}`;
  const m = preview.match(/\b([A-Z][A-Z0-9_]{2,})\s*=/i);
  if (m?.[1]) return `ASSIGN:${upper(m[1])}`;
  return "VALUE";
}

/** FORM/METHOD/routine name from explicit subobject or evidence text. */
export function extractRoutineIdentifier(hit: KnowledgeHit): string {
  const sub = upper(hit.subobject_name ?? "");
  if (sub) return sub;
  const blob = `${hit.title ?? ""}\n${hit.snippet ?? ""}\n${hit.technical_summary ?? ""}`;
  const form = blob.match(/\bFORM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  if (form?.[1]) return upper(form[1]);
  const method = blob.match(/\bMETHOD\s+([A-Za-z_][A-Za-z0-9_~]*)/i);
  if (method?.[1]) return upper(method[1]);
  const perform = blob.match(/\bPERFORM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  if (perform?.[1]) return upper(perform[1]);
  return "";
}

function routineKindFromHit(hit: KnowledgeHit, routine: string): string {
  const blob = `${hit.subobject_name ?? ""} ${hit.snippet ?? ""} ${hit.title ?? ""}`;
  if (new RegExp(`\\bFORM\\s+${routine}\\b`, "i").test(blob)) return "FORM";
  if (new RegExp(`\\bMETHOD\\s+${routine}\\b`, "i").test(blob)) return "METHOD";
  if (new RegExp(`\\bPERFORM\\s+${routine}\\b`, "i").test(blob)) return "PERFORM";
  if (hit.subobject_name) return "ROUTINE";
  return "ROUTINE";
}

function hitStrength(hit: KnowledgeHit): number {
  let s = hit.exact_score * 20 + hit.combined_score;
  if (hit.metadata?.exact_authoritative === true) s += 500;
  if (hit.metadata?.seed_enrichment === true) s += 200;
  if (hit.metadata?.config_table_expansion === true) s += 150;
  if (hit.metadata?.symbol_name_containment === true) s += 50;
  const facts = hit.facts?.length ?? 0;
  const evidence = hit.evidence?.length ?? 0;
  s += Math.min(40, facts * 2 + evidence);
  // Prefer richer snippets.
  s += Math.min(20, (hit.snippet?.length ?? 0) / 40);
  return s;
}

export type DedupeFinalEvidenceResult = {
  hits: KnowledgeHit[];
  merged_groups: number;
};

/**
 * Deduplicate final sources for the user context.
 * Keeps the strongest hit per canonical identity; records sibling ids in metadata.
 */
export function dedupeFinalEvidenceHits(
  hits: KnowledgeHit[],
): DedupeFinalEvidenceResult {
  if (hits.length <= 1) {
    return { hits, merged_groups: 0 };
  }

  const groups = new Map<string, KnowledgeHit[]>();
  for (const h of hits) {
    const key = canonicalEvidenceIdentity(h);
    const list = groups.get(key) ?? [];
    list.push(h);
    groups.set(key, list);
  }

  let merged_groups = 0;
  const out: KnowledgeHit[] = [];

  for (const [, group] of groups) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    merged_groups += 1;
    const ranked = [...group].sort((a, b) => hitStrength(b) - hitStrength(a));
    const best = ranked[0]!;
    const siblingIds = ranked
      .slice(1)
      .map((h) => h.search_document_id)
      .filter(Boolean);
    const siblingKeys = ranked
      .slice(1)
      .map((h) => h.source_key)
      .filter(Boolean);
    out.push({
      ...best,
      metadata: {
        ...(best.metadata ?? {}),
        evidence_deduped: true,
        evidence_dedupe_count: group.length,
        evidence_dedupe_sibling_ids: siblingIds,
        evidence_dedupe_sibling_keys: siblingKeys,
      },
    });
  }

  // Preserve relative preference: re-sort by strength, then renumber ranks.
  out.sort((a, b) => hitStrength(b) - hitStrength(a));
  return {
    hits: out.map((h, i) => ({ ...h, rank: i + 1 })),
    merged_groups,
  };
}

/** Normalize claim text for statement-level dedup (process_answer). */
export function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[„“"']/g, "")
    .trim();
}

export function dedupeClaimStatements<
  T extends { text: string; source_ranks?: number[]; source_ids?: string[] },
>(stmts: T[]): T[] {
  const seen = new Map<string, T>();
  for (const s of stmts) {
    const key = normalizeClaimText(s.text);
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, s);
      continue;
    }
    // Merge source refs onto the first (keep first wording).
    const ranks = [
      ...new Set([...(prev.source_ranks ?? []), ...(s.source_ranks ?? [])]),
    ];
    const ids = [
      ...new Set([...(prev.source_ids ?? []), ...(s.source_ids ?? [])]),
    ];
    seen.set(key, { ...prev, source_ranks: ranks, source_ids: ids });
  }
  return [...seen.values()];
}
