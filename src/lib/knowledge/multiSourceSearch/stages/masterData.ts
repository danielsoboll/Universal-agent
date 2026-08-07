/**
 * Stage A — Master data: structure (Z/Y fields) then targeted content values.
 * Streams canonical structure/content; no hybrid dependency.
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
  pickPrimaryAnchorFromFieldCandidates,
  scoreMasterDataFieldCandidate,
} from "@/lib/knowledge/multiSourceSearch/primaryAnchor";
import {
  asRecord,
  asString,
  streamJsonlObjects,
  textMatchesAny,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import type {
  MultiSourceSearchPlan,
  PrimaryAnchor,
  SourceCoverage,
  SpecializedSearchPlan,
  StageEvidenceItem,
  StageResult,
} from "@/lib/knowledge/multiSourceSearch/types";

const DOMAINS = ["materials", "customers", "vendors"] as const;
const MAX_FIELD_HITS = 40;
const MAX_VALUE_SAMPLES_PER_FIELD = 8;
const MAX_CONTENT_SCAN_PER_TABLE = 120_000;

type FieldHit = {
  domain: string;
  table_name: string;
  field_name: string;
  description: string;
  data_element: string;
  sap_domain?: string;
  data_type?: string;
  length?: string;
  matched: string;
  structure_path: string;
  candidate_score: number;
};

export async function runMasterDataStage(params: {
  projectKey: string;
  plan: MultiSourceSearchPlan;
  anchors: AnchorSet;
  coverage: SourceCoverage;
  round: number;
  specialized?: SpecializedSearchPlan;
}): Promise<StageResult & { primary_anchor_detected?: PrimaryAnchor | null }> {
  const started = Date.now();
  const queries: StageResult["queries"] = [];
  const hits: StageEvidenceItem[] = [];
  const newAnchors: ReturnType<typeof makeAnchor>[] = [];

  if (!params.coverage.exists || params.coverage.status === "missing") {
    return {
      stage: "master_data",
      round: params.round,
      inputs: {
        anchors: params.anchors.allNeedles(),
        concepts: params.plan.concepts,
        synonyms: params.plan.synonym_candidates,
      },
      queries,
      hits: [],
      new_anchors: [],
      confidence: 0,
      why_next: "Master-Data fehlt — weiter mit Control Tables / Hybrid.",
      abort: true,
      abort_reason: params.coverage.diagnosis,
      coverage: params.coverage,
      duration_ms: Date.now() - started,
    };
  }

  const needles = [
    ...params.plan.synonym_candidates,
    ...params.plan.concepts,
    ...params.anchors.allNeedles(),
  ].filter((n) => n.trim().length >= 2);

  queries.push({
    query: needles.slice(0, 20).join(" | "),
    purpose: "structure: Z/Y-Felder gegen Synonyme/Konzepte",
    hit_count: 0,
  });

  const fieldHits: FieldHit[] = [];
  const mdRoot = resolveProjectZonePath(
    params.projectKey,
    "canonical",
    "master-data",
  );

  for (const domain of DOMAINS) {
    const domainDir = path.join(mdRoot, domain);
    if (!existsSync(domainDir) || !statSync(domainDir).isDirectory()) continue;
    for (const table of readdirSync(domainDir)) {
      const structurePath = path.join(domainDir, table, "structure.jsonl");
      if (!existsSync(structurePath)) continue;
      for await (const rec of streamJsonlObjects(structurePath)) {
        if (asString(rec.record_type) !== "master_field_definition") continue;
        const field_name = asString(rec.field_name);
        if (!field_name) continue;
        const description = asString(rec.description);
        const data_element = asString(rec.data_element);
        const blob = `${field_name} ${description} ${data_element}`;
        const matched = textMatchesAny(blob, needles);
        if (!matched) continue;
        const scored = scoreMasterDataFieldCandidate({
          table_name: asString(rec.table_name) || table,
          field_name,
          description,
          data_element,
          plan: params.plan,
        });
        const descLower = `${description} ${data_element}`.toLowerCase();
        const conceptHits = params.plan.concepts.filter(
          (c) => c.length >= 4 && descLower.includes(c.toLowerCase()),
        ).length;
        // Prefer custom Z/Y fields. Standard fields only if description matches ≥2 concepts
        // or an intensifier concept such as virtuell*/virtual* (avoids flooding LGORT from bare "lager").
        if (!isZLikeField(field_name)) {
          const hasVirt = /virtuell|virtual/.test(descLower);
          if (!hasVirt && conceptHits < 2) continue;
          if (!hasVirt && matched.length < 5) continue;
        }
        fieldHits.push({
          domain,
          table_name: asString(rec.table_name) || table,
          field_name,
          description,
          data_element,
          sap_domain: asString(rec.domain),
          data_type: asString(rec.data_type),
          length: asString(rec.length),
          matched,
          structure_path: `canonical/master-data/${domain}/${table}/structure.jsonl`,
          candidate_score: scored.score,
        });
        if (fieldHits.length >= MAX_FIELD_HITS) break;
      }
      if (fieldHits.length >= MAX_FIELD_HITS) break;
    }
    if (fieldHits.length >= MAX_FIELD_HITS) break;
  }

  queries[0]!.hit_count = fieldHits.length;

  // Prefer Z-like + high business concept score
  fieldHits.sort((a, b) => {
    const az = isZLikeField(a.field_name) ? 1 : 0;
    const bz = isZLikeField(b.field_name) ? 1 : 0;
    if (bz !== az) return bz - az;
    return b.candidate_score - a.candidate_score;
  });

  const primaryCandidates = fieldHits.map((fh) =>
    scoreMasterDataFieldCandidate({
      table_name: fh.table_name,
      field_name: fh.field_name,
      description: fh.description,
      data_element: fh.data_element,
      plan: params.plan,
    }),
  );
  const primary_anchor_detected =
    params.specialized?.primary_anchor ??
    pickPrimaryAnchorFromFieldCandidates(primaryCandidates);

  for (const fh of fieldHits.slice(0, 20)) {
    const isPrimary =
      primary_anchor_detected &&
      fh.table_name === primary_anchor_detected.table &&
      fh.field_name === primary_anchor_detected.field;
    hits.push({
      id: `md-field:${fh.table_name}.${fh.field_name}`,
      source: "master_data",
      rank_tier: isPrimary || isZLikeField(fh.field_name) ? "exact" : "value_check",
      evidence_type: isPrimary
        ? "MASTER_DATA_BUSINESS_FIELD"
        : isZLikeField(fh.field_name)
          ? "MASTER_DATA_BUSINESS_FIELD"
          : undefined,
      title: `${fh.table_name}-${fh.field_name}`,
      summary: [
        fh.description || fh.data_element || "Felddefinition",
        fh.data_type ? `Typ=${fh.data_type}` : null,
        fh.sap_domain ? `Domäne=${fh.sap_domain}` : null,
        fh.length ? `Länge=${fh.length}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      table_name: fh.table_name,
      field_name: fh.field_name,
      anchors_matched: [fh.matched, fh.field_name],
      confidence: isPrimary
        ? primary_anchor_detected!.confidence
        : isZLikeField(fh.field_name)
          ? 0.9
          : 0.65,
      path_hint: fh.structure_path,
      primary_anchor: isPrimary ? primary_anchor_detected : undefined,
    });
    if (isZLikeField(fh.field_name)) {
      newAnchors.push(
        makeAnchor({
          kind: "field",
          value: fh.field_name,
          source: "master_data",
          confidence: 0.9,
          note: `${fh.table_name}: ${fh.description}`,
        }),
      );
      newAnchors.push(
        makeAnchor({
          kind: "table",
          value: fh.table_name,
          source: "master_data",
          confidence: 0.55,
          note: "master-data table (context)",
        }),
      );
    }
  }

  // Targeted content values — primary anchor first, then other Z-fields
  const targetFields = fieldHits
    .filter((f) => {
      if (primary_anchor_detected) {
        return (
          f.table_name === primary_anchor_detected.table &&
          f.field_name === primary_anchor_detected.field
        );
      }
      return isZLikeField(f.field_name);
    })
    .concat(
      fieldHits.filter(
        (f) =>
          isZLikeField(f.field_name) &&
          f.table_name !== primary_anchor_detected?.table &&
          f.field_name !== primary_anchor_detected?.field,
      ),
    )
    .slice(0, 8);

  for (const tf of targetFields) {
    const contentPath = path.join(
      mdRoot,
      tf.domain,
      tf.table_name,
      "content.jsonl",
    );
    if (!existsSync(contentPath)) continue;
    const valueDist = new Map<string, number>();
    const samples: Record<string, string>[] = [];
    let scanned = 0;
    for await (const rec of streamJsonlObjects(contentPath)) {
      scanned += 1;
      if (scanned > MAX_CONTENT_SCAN_PER_TABLE) break;
      const values = asRecord(rec.values);
      if (!values) continue;
      const raw = values[tf.field_name];
      const val = asString(raw).trim();
      if (!val) continue;
      valueDist.set(val, (valueDist.get(val) ?? 0) + 1);
      if (samples.length < MAX_VALUE_SAMPLES_PER_FIELD) {
        const sample: Record<string, string> = {
          [tf.field_name]: val,
        };
        for (const k of ["KUNNR", "MATNR", "LIFNR", "WERKS", "LGORT", "VKORG"]) {
          const kv = asString(values[k]).trim();
          if (kv) sample[k] = kv;
        }
        samples.push(sample);
      }
    }
    queries.push({
      query: `${tf.table_name}.${tf.field_name}`,
      purpose: "content: gezielte Werte für gefundenes Z-Feld",
      hit_count: [...valueDist.values()].reduce((a, b) => a + b, 0),
    });

    const topValues = [...valueDist.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    if (topValues.length > 0) {
      const emptyCount = valueDist.get("") ?? valueDist.get(" ") ?? 0;
      hits.push({
        id: `md-values:${tf.table_name}.${tf.field_name}`,
        source: "master_data",
        rank_tier: "value_check",
        evidence_type: "MASTER_DATA_BUSINESS_VALUE",
        title: `Werte ${tf.table_name}.${tf.field_name}`,
        summary: [
          topValues.map(([v, c]) => `${v || "(leer)"} (n=${c})`).join("; "),
          emptyCount > 0 ? `leer/nicht gesetzt: ${emptyCount}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        table_name: tf.table_name,
        field_name: tf.field_name,
        values: Object.fromEntries(
          topValues.map(([v, c]) => [v || "(leer)", String(c)]),
        ),
        anchors_matched: [tf.field_name, ...topValues.map(([v]) => v)],
        confidence: 0.85,
        path_hint: `canonical/master-data/${tf.domain}/${tf.table_name}/content.jsonl`,
        raw_excerpt: JSON.stringify(samples.slice(0, 5)),
      });
      // Value anchors only for low-cardinality indicator fields (not KUNNR-like IDs)
      const distinctCount = valueDist.size;
      const isIndicator = /KENNZ|FLAG|KZ|_X$|IND|BOOL/i.test(tf.field_name);
      if (isIndicator && distinctCount <= 12) {
        for (const [v] of topValues) {
          if (v.length <= 1 || /^[XYN]$/i.test(v)) {
            // Keep field+value compound for flags
            newAnchors.push(
              makeAnchor({
                kind: "key",
                value: `${tf.field_name}=${v}`,
                source: "master_data",
                confidence: 0.85,
                note: `${tf.table_name} flag`,
              }),
            );
            continue;
          }
          if (v.length > 40) continue;
          newAnchors.push(
            makeAnchor({
              kind: "value",
              value: v,
              source: "master_data",
              confidence: 0.75,
              note: `${tf.table_name}.${tf.field_name}`,
            }),
          );
        }
      }
      // Do not emit free KUNNR/MATNR key samples as global needles (too noisy).
    }
  }

  const confidence =
    hits.length === 0
      ? 0.1
      : Math.min(
          0.95,
          0.4 +
            hits.filter((h) => h.evidence_type === "MASTER_DATA_BUSINESS_FIELD").length *
              0.12 +
            hits.filter((h) => h.evidence_type === "MASTER_DATA_BUSINESS_VALUE").length *
              0.06,
        );

  const why_next = primary_anchor_detected
    ? `Primäranker ${primary_anchor_detected.table}-${primary_anchor_detected.field} — fokussierte Code-/Steuertabellen-Suche.`
    : hits.length > 0
      ? "Feld-/Wert-Anker für Control Tables und Code-Suche nutzen."
      : "Keine Master-Data-Treffer — Control Tables mit Frage-Synonymen versuchen.";

  return {
    stage: "master_data",
    round: params.round,
    inputs: {
      anchors: params.anchors.allNeedles(),
      concepts: params.plan.concepts,
      synonyms: params.plan.synonym_candidates,
    },
    queries,
    hits,
    new_anchors: newAnchors.filter(Boolean) as NonNullable<
      ReturnType<typeof makeAnchor>
    >[],
    confidence,
    why_next,
    abort: false,
    coverage: params.coverage,
    duration_ms: Date.now() - started,
    primary_anchor_detected,
  };
}
