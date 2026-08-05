/**
 * Multi-source stage 0: exact technical symbol search across all corpora.
 * Runs before semantic / concept stages. Never drops a real symbol hit.
 *
 * Needles come ONLY from technical tokens in the question — never from
 * LLM/generic synonym hints like "LGORT" or "ZZ_* Felder".
 */
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  AnchorSet,
  isZLikeField,
  makeAnchor,
} from "@/lib/knowledge/multiSourceSearch/anchors";
import {
  asString,
  streamJsonlObjects,
  textMatchesAny,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import type {
  MultiSourceSearchPlan,
  SourceCoverage,
  StageEvidenceItem,
  StageResult,
} from "@/lib/knowledge/multiSourceSearch/types";
import {
  extractTechnicalSymbols,
  technicalSymbolNeedles,
} from "@/lib/search/technicalSymbols";

const DOMAINS = ["materials", "customers", "vendors"] as const;

function listStrings(rec: Record<string, unknown>, key: string): string[] {
  const v = rec[key];
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter(Boolean);
}

function nameMatchScore(objectName: string, unitName: string, needle: string): number {
  const o = objectName.toUpperCase();
  const u = unitName.toUpperCase();
  const n = needle.toUpperCase();
  if (o === n || u === n) return 100;
  if (o.includes(n) || u.includes(n)) return 80;
  return 0;
}

export async function runExactSymbolStage(params: {
  projectKey: string;
  plan: MultiSourceSearchPlan;
  anchors: AnchorSet;
  coverage: SourceCoverage[];
  round: number;
}): Promise<StageResult> {
  const started = Date.now();
  const symbols = extractTechnicalSymbols(params.plan.question);
  // Needles ONLY from the question — never from LLM/generic synonyms
  // (those inject WISSEN, ALE, IDOC, WE02, … and drown real question symbols).
  const uniqueNeedles = [
    ...new Set(technicalSymbolNeedles(symbols).filter((n) => n.length >= 2)),
  ];
  const queries: StageResult["queries"] = [];
  const hits: StageEvidenceItem[] = [];
  const newAnchors: NonNullable<ReturnType<typeof makeAnchor>>[] = [];
  const seen = new Set<string>();

  if (uniqueNeedles.length === 0) {
    return {
      stage: "exact_symbol",
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
      why_next: "Keine technischen Symbole in der Frage — weiter mit Konzeptsuche.",
      abort: false,
      coverage:
        params.coverage.find((c) => c.source === "master_data") ??
        params.coverage[0]!,
      duration_ms: Date.now() - started,
    };
  }

  queries.push({
    query: uniqueNeedles.slice(0, 20).join(" | "),
    purpose: "exact_symbol_global",
    hit_count: 0,
  });

  // --- Master data structures ---
  const mdRoot = resolveProjectZonePath(
    params.projectKey,
    "canonical",
    "master-data",
  );
  if (existsSync(mdRoot)) {
    let mdHits = 0;
    for (const domain of DOMAINS) {
      const domainDir = path.join(mdRoot, domain);
      if (!existsSync(domainDir) || !statSync(domainDir).isDirectory()) continue;
      for (const table of readdirSync(domainDir)) {
        const structurePath = path.join(domainDir, table, "structure.jsonl");
        if (!existsSync(structurePath)) continue;
        for await (const rec of streamJsonlObjects(structurePath)) {
          if (asString(rec.record_type) !== "master_field_definition") continue;
          const field_name = asString(rec.field_name);
          const table_name = asString(rec.table_name) || table;
          const description = asString(rec.description);
          const data_element = asString(rec.data_element);
          const blob = `${table_name} ${field_name} ${description} ${data_element} ${table_name}-${field_name}`;
          const matched = textMatchesAny(blob, uniqueNeedles);
          if (!matched) continue;
          const id = `sym-md:${table_name}.${field_name}`;
          if (seen.has(id)) continue;
          seen.add(id);
          mdHits += 1;
          const isZ = isZLikeField(field_name);
          hits.push({
            id,
            source: "exact_symbol",
            rank_tier: "exact",
            evidence_type: isZ
              ? "MASTER_DATA_BUSINESS_FIELD"
              : "EXACT_CODE_USAGE",
            title: `${table_name}-${field_name}`,
            summary: description || data_element || "Felddefinition",
            table_name,
            field_name,
            anchors_matched: [matched, field_name],
            confidence: isZ ? 0.99 : 0.85,
            path_hint: `canonical/master-data/${domain}/${table}/structure.jsonl`,
          });
          if (isZ) {
            const a = makeAnchor({
              kind: "field",
              value: field_name,
              source: "exact_symbol",
              confidence: 0.99,
              note: `${table_name}: ${description}`,
            });
            if (a) newAnchors.push(a);
            const t = makeAnchor({
              kind: "table",
              value: table_name,
              source: "exact_symbol",
              confidence: 0.7,
            });
            if (t) newAnchors.push(t);
          }
          if (mdHits >= 40) break;
        }
        if (mdHits >= 40) break;
      }
      if (mdHits >= 40) break;
    }
    queries.push({
      query: uniqueNeedles.slice(0, 12).join(" | "),
      purpose: "exact_symbol_master_data_structure",
      hit_count: mdHits,
    });
  }

  // --- Programs / FMs extracts (name matches first) ---
  for (const [corpus, rel] of [
    ["programs", ["programs", "extracts.jsonl"]],
    ["function_modules", ["function-modules", "extracts.jsonl"]],
  ] as const) {
    const abs = resolveProjectZonePath(
      params.projectKey,
      "canonical",
      ...rel,
    );
    if (!existsSync(abs)) continue;

    type Cand = {
      score: number;
      hit: StageEvidenceItem;
      object_name: string;
    };
    const candidates: Cand[] = [];

    for await (const rec of streamJsonlObjects(abs)) {
      const object_name = asString(rec.object_name);
      const unit_name = asString(rec.unit_name);
      const fields = listStrings(rec, "fields");
      const tables = [
        ...listStrings(rec, "tables_read"),
        ...listStrings(rec, "tables_zy"),
        ...listStrings(rec, "tables_written"),
      ];
      const calls = listStrings(rec, "call_function");
      const hardcoded = listStrings(rec, "hardcoded_values");
      const blob = [
        object_name,
        unit_name,
        ...fields,
        ...tables,
        ...calls,
        ...hardcoded,
      ].join(" ");
      const matched = textMatchesAny(blob, uniqueNeedles);
      if (!matched) continue;

      const nameScore = Math.max(
        ...uniqueNeedles.map((n) => nameMatchScore(object_name, unit_name, n)),
        0,
      );
      const callScore = calls.some((c) =>
        uniqueNeedles.some((n) => c.toUpperCase().includes(n.toUpperCase())),
      )
        ? 40
        : 0;
      const hardScore = hardcoded.some((h) =>
        uniqueNeedles.some((n) => h.toUpperCase().includes(n.toUpperCase())),
      )
        ? 25
        : 0;
      const score = nameScore + callScore + hardScore + (matched ? 10 : 0);

      const id = `sym-${corpus}:${asString(rec.unit_key) || `${object_name}.${unit_name}`}`;
      if (seen.has(id)) continue;
      seen.add(id);

      candidates.push({
        score,
        object_name,
        hit: {
          id,
          source: "exact_symbol",
          rank_tier: "exact",
          evidence_type: "EXACT_CODE_USAGE",
          title: `${object_name} · ${unit_name}`,
          summary: [
            `Exakter Symboltreffer (${matched}) in ${corpus}`,
            nameScore >= 80 ? "— Name enthält Symbol" : "",
            tables.length ? `· tables=${tables.slice(0, 8).join(",")}` : "",
            calls.length ? `· calls=${calls.slice(0, 6).join(",")}` : "",
          ]
            .filter(Boolean)
            .join(" "),
          object_name: object_name || undefined,
          object_type:
            corpus === "function_modules" ? "FUNCTION_MODULE" : "PROGRAM",
          tables_read: listStrings(rec, "tables_read").slice(0, 20),
          tables_written: listStrings(rec, "tables_written").slice(0, 20),
          called_functions: calls.slice(0, 20),
          called_methods: listStrings(rec, "call_method").slice(0, 12),
          evidence_lines: hardcoded
            .filter((h) =>
              uniqueNeedles.some((n) =>
                h.toUpperCase().includes(n.toUpperCase()),
              ),
            )
            .slice(0, 8),
          anchors_matched: [matched, object_name, unit_name].filter(Boolean),
          confidence: nameScore >= 80 ? 0.99 : 0.92,
          path_hint: `canonical/${rel.join("/")}`,
        },
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const take = candidates.slice(0, 24);
    for (const c of take) {
      hits.push(c.hit);
      if (c.object_name) {
        const a = makeAnchor({
          kind: "object",
          value: c.object_name,
          source: "exact_symbol",
          confidence: c.score >= 80 ? 0.98 : 0.9,
          note: `exact_symbol:${corpus}`,
        });
        if (a) newAnchors.push(a);
      }
    }
    queries.push({
      query: uniqueNeedles.slice(0, 12).join(" | "),
      purpose: `exact_symbol_${corpus}`,
      hit_count: take.length,
    });
  }

  // --- Classes analyses ---
  const analysesPath = resolveProjectZonePath(
    params.projectKey,
    "analyses",
    "classes",
    "unit_analyses.jsonl",
  );
  if (existsSync(analysesPath)) {
    type Cand = { score: number; hit: StageEvidenceItem; className: string };
    const candidates: Cand[] = [];
    for await (const rec of streamJsonlObjects(analysesPath)) {
      const className = asString(rec.class_name);
      const methodName = asString(rec.method_name);
      const searchText = asString(rec.search_text);
      const blob = `${className} ${methodName} ${searchText} ${JSON.stringify(rec.tables_read ?? [])}`;
      const matched = textMatchesAny(blob, uniqueNeedles);
      if (!matched) continue;
      const nameScore = Math.max(
        ...uniqueNeedles.map((n) => nameMatchScore(className, methodName, n)),
        0,
      );
      const id = `sym-class:${asString(rec.source_key) || `${className}.${methodName}`}`;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({
        score: nameScore + 10,
        className,
        hit: {
          id,
          source: "exact_symbol",
          rank_tier: "exact",
          evidence_type: "EXACT_CODE_USAGE",
          title: `${className}.${methodName}`,
          summary: asString(rec.technical_summary).slice(0, 400),
          object_name: className || undefined,
          anchors_matched: [matched],
          confidence: nameScore >= 80 ? 0.99 : 0.92,
          path_hint: "analyses/classes/unit_analyses.jsonl",
        },
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    const take = candidates.slice(0, 24);
    for (const c of take) {
      hits.push(c.hit);
      if (c.className) {
        const a = makeAnchor({
          kind: "object",
          value: c.className,
          source: "exact_symbol",
          confidence: 0.9,
        });
        if (a) newAnchors.push(a);
      }
    }
    queries.push({
      query: uniqueNeedles.slice(0, 12).join(" | "),
      purpose: "exact_symbol_classes",
      hit_count: take.length,
    });
  }

  // --- MESSAGE_IDOC_CONFIG canonical objects (incremental corpus) ---
  const msgIdocPath = resolveProjectZonePath(
    params.projectKey,
    "canonical",
    "message-idoc-config",
    "objects.jsonl",
  );
  if (existsSync(msgIdocPath)) {
    type Cand = {
      score: number;
      hit: StageEvidenceItem;
      objectName: string;
    };
    const candidates: Cand[] = [];
    for await (const rec of streamJsonlObjects(msgIdocPath)) {
      const objectType = asString(rec.object_type);
      const objectId = asString(rec.object_id);
      const display = asString(rec.display_name);
      const attrs =
        rec.attributes && typeof rec.attributes === "object"
          ? (rec.attributes as Record<string, unknown>)
          : {};
      const attrBlob = Object.values(attrs)
        .map((v) => String(v ?? ""))
        .join(" ");
      const blob = `${objectType} ${objectId} ${display} ${attrBlob}`;
      const matched = textMatchesAny(blob, uniqueNeedles);
      if (!matched) continue;
      const nameScore = Math.max(
        ...uniqueNeedles.map((n) => nameMatchScore(objectId, display, n)),
        0,
      );
      // Prefer identity fields matching the needle (KSCHL, MSGTYP, …)
      let attrBoost = 0;
      for (const n of uniqueNeedles) {
        const nu = n.toUpperCase();
        for (const k of [
          "KSCHL",
          "MSGTYP",
          "MESTYP",
          "IDOCTYP",
          "PGNAM",
          "PORT",
          "PARNUM",
          "EVCODE",
        ]) {
          if (String(attrs[k] ?? "").toUpperCase() === nu) attrBoost = 40;
        }
      }
      const id = `sym-msgidoc:${asString(rec._canonical_key) || objectId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({
        score: nameScore + attrBoost + 15,
        objectName: objectId,
        hit: {
          id,
          source: "exact_symbol",
          rank_tier: "exact",
          evidence_type: "EXACT_CODE_USAGE",
          title: `${objectType}: ${display || objectId}`,
          summary: `MESSAGE_IDOC ${objectType} ${objectId}`.slice(0, 400),
          object_name: objectId || undefined,
          table_name: asString(
            (rec.source as { source_table?: string } | undefined)?.source_table,
          ) || undefined,
          anchors_matched: [matched, objectId].filter(Boolean),
          confidence: nameScore + attrBoost >= 80 ? 0.99 : 0.93,
          path_hint: "canonical/message-idoc-config/objects.jsonl",
          related_to_symbol: true,
        },
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    const take = candidates.slice(0, 30);
    for (const c of take) {
      hits.push(c.hit);
      if (c.objectName) {
        const a = makeAnchor({
          kind: "object",
          value: c.objectName,
          source: "exact_symbol",
          confidence: c.score >= 80 ? 0.98 : 0.9,
          note: "exact_symbol:message_idoc_config",
        });
        if (a) newAnchors.push(a);
      }
    }
    queries.push({
      query: uniqueNeedles.slice(0, 12).join(" | "),
      purpose: "exact_symbol_message_idoc_config",
      hit_count: take.length,
    });
  }

  queries[0]!.hit_count = hits.length;

  for (const sym of symbols) {
    const a = makeAnchor({
      kind:
        sym.kind === "compound_field"
          ? "field"
          : sym.kind === "zy_name"
            ? "field"
            : "symbol",
      value: sym.raw,
      source: "question",
      confidence: 0.95,
      note: `technical_symbol:${sym.kind}`,
    });
    if (a) newAnchors.push(a);
  }

  const mdPrimary = hits.find(
    (h) => h.evidence_type === "MASTER_DATA_BUSINESS_FIELD",
  );
  const strongCode = hits.find(
    (h) =>
      h.evidence_type === "EXACT_CODE_USAGE" &&
      (h.confidence ?? 0) >= 0.98 &&
      uniqueNeedles.some(
        (n) =>
          (h.object_name ?? "").toUpperCase().includes(n) ||
          (h.title ?? "").toUpperCase().includes(n),
      ),
  );

  return {
    stage: "exact_symbol",
    round: params.round,
    inputs: {
      anchors: uniqueNeedles,
      concepts: params.plan.concepts,
      synonyms: params.plan.synonym_candidates,
    },
    queries,
    hits,
    new_anchors: newAnchors,
    confidence: mdPrimary ? 0.99 : strongCode ? 0.97 : hits.length ? 0.85 : 0.2,
    why_next: mdPrimary
      ? `Exactes Stammdatenfeld ${mdPrimary.title} — Primäranker-Kandidat.`
      : strongCode
        ? `Exakter Code-Symboltreffer ${strongCode.title} — nicht verwerfen trotz ungenauem Objekttyp in der Frage.`
        : hits.length
          ? `${hits.length} Exact-Symbol-Treffer — Konzeptsuche ergänzt.`
          : "Keine Exact-Symbol-Treffer — Konzeptsuche.",
    abort: false,
    coverage:
      params.coverage.find((c) => c.source === "exact_symbol") ??
      params.coverage[0]!,
    duration_ms: Date.now() - started,
  };
}
