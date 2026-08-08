/**
 * Deterministically inject enrichment facts into process/technical answers
 * according to presentation hint — retrieval basis unchanged.
 */
import type {
  ProcessAnswer,
  TechnicalAnswer,
} from "@/lib/knowledge/answerSchema";
import type {
  PresentationHint,
  SeedEnrichmentPack,
} from "@/lib/knowledge/seedEnrichment/types";

function stmt(text: string, source_ids: string[] = []) {
  return {
    text,
    level: "confirmed" as const,
    source_ranks: [] as number[],
    source_ids,
  };
}

export function applySeedEnrichmentToAnswer(params: {
  process_answer: ProcessAnswer;
  technical_answer: TechnicalAnswer;
  pack: SeedEnrichmentPack;
  hint: PresentationHint;
}): { process_answer: ProcessAnswer; technical_answer: TechnicalAnswer } {
  if (!params.pack.enriched) {
    return {
      process_answer: params.process_answer,
      technical_answer: params.technical_answer,
    };
  }

  const pa = { ...params.process_answer };
  const ta = {
    entry_point: [...params.technical_answer.entry_point],
    trigger: [...params.technical_answer.trigger],
    processing: [...params.technical_answer.processing],
    objects: [...params.technical_answer.objects],
    results: [...params.technical_answer.results],
    relations: [...params.technical_answer.relations],
    open: [...params.technical_answer.open],
  };
  const confirmed = [...(pa.confirmed ?? [])];
  const extras: string[] = [];

  for (const e of params.pack.field_enrichments) {
    const fieldLabel = e.ddic?.table_name
      ? `${e.ddic.table_name}-${e.ddic.field_name}`
      : e.seed.field_name;
    const src = e.evidence_paths;

    // Always: what marks it
    const mark = `Kennzeichen/Feld: ${fieldLabel}${
      e.ddic?.description ? ` — ${e.ddic.description}` : ""
    }`;
    confirmed.push(stmt(mark, src));
    ta.objects.push(stmt(mark, src));

    if (e.observed_values.length) {
      const vals = `Vorkommende Werte von ${fieldLabel}: ${e.observed_values
        .map((v) => `${v.value} (${v.count})`)
        .join(", ")}`;
      confirmed.push(stmt(vals, src));
      ta.results.push(stmt(vals, src));
    }

    if (e.master_instances.total_attributes > 0) {
      const countLine = `Das Kennzeichen ist aktuell bei ${e.master_instances.total_attributes} Vertriebsbereichszuordnungen gesetzt (${e.master_instances.distinct_customers} Kunden).`;
      const orgLine = [
        e.master_instances.vkorg_dist.length
          ? `VKORG: ${e.master_instances.vkorg_dist.map((v) => `${v.value} (${v.count})`).join(", ")}`
          : "",
        e.master_instances.vtweg_dist.length
          ? `VTWEG: ${e.master_instances.vtweg_dist.map((v) => `${v.value} (${v.count})`).join(", ")}`
          : "",
        e.master_instances.spart_dist.length
          ? `SPART: ${e.master_instances.spart_dist.map((v) => `${v.value} (${v.count})`).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; ");
      const samples = e.master_instances.samples
        .slice(0, 3)
        .map(
          (s) =>
            `${s.kunnr ?? "?"}${s.name1 ? ` (${s.name1})` : ""} ${s.vkorg}/${s.vtweg}/${s.spart}=${s.value}`,
        )
        .join("; ");

      if (
        params.hint === "how_works" ||
        params.hint === "which_instances" ||
        params.hint === "generic"
      ) {
        confirmed.push(stmt(countLine, src));
        if (orgLine) confirmed.push(stmt(orgLine, src));
        if (samples) {
          confirmed.push(
            stmt(
              `Beispiele (Auszug): ${samples}. Vollständige Liste in Entity-/Access-Index.`,
              src,
            ),
          );
        }
        extras.push(countLine);
      }

      if (params.hint === "which_instances") {
        ta.results.push(stmt(countLine, src));
        if (samples) ta.results.push(stmt(`Beispiele: ${samples}`, src));
      }
    }

    if (e.code_usage.total > 0) {
      const codeLine = `Belegte Code-Usage zu ${fieldLabel}: ${e.code_usage.total} (${Object.entries(
        e.code_usage.by_relation,
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})`;
      const codeSamples = e.code_usage.samples
        .slice(0, 5)
        .map(
          (c) =>
            `${c.object_name}${c.subobject_name ? `/${c.subobject_name}` : ""} [${c.relation}]`,
        )
        .join("; ");

      if (
        params.hint === "how_works" ||
        params.hint === "where_used" ||
        params.hint === "generic"
      ) {
        confirmed.push(stmt(codeLine, src));
        if (codeSamples) confirmed.push(stmt(`Code-Beispiele: ${codeSamples}`, src));
        ta.processing.push(stmt(codeLine, src));
        for (const c of e.code_usage.samples.slice(0, 4)) {
          ta.objects.push(
            stmt(
              `${c.relation}: ${c.object_name}${c.subobject_name ? ` / ${c.subobject_name}` : ""}`,
              [c.source_key],
            ),
          );
        }
      }
    }

    if (e.config_neighbors.length) {
      const cfg = `Vorhandene Config/Graph-Nachbarn: ${e.config_neighbors
        .map((c) => c.object_name)
        .join(", ")}`;
      if (params.hint === "how_works" || params.hint === "generic") {
        confirmed.push(stmt(cfg, src));
        ta.relations.push(stmt(cfg, src));
      }
    }
  }

  // Ensure direct_answer mentions counts when LLM omitted them
  let direct = pa.direct_answer || "";
  for (const line of extras) {
    const needle = /(\d+)\s+Vertriebsbereich/i;
    const m = line.match(needle);
    if (m && !direct.includes(m[1]!)) {
      direct = direct.trim()
        ? `${direct.trim()}\n\n${line}`
        : line;
    }
  }

  pa.confirmed = confirmed;
  pa.direct_answer = direct;
  if (confirmed.length > 0) {
    pa.has_safe_process_claim = true;
  }

  return { process_answer: pa, technical_answer: ta };
}
