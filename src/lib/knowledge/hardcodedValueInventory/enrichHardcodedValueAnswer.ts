/**
 * Stage-2: Datenbasis-backed evidence → precise OpenAI question → validated answer.
 *
 * Counts in the executive summary always come from the deterministic scan.
 */
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { AI_CONFIG } from "@/lib/ai/config";
import type {
  HardcodedMaterialCard,
  HardcodedValueAnswerView,
} from "./types";
import { prepareHardcodedEvidence } from "./prepareHardcodedEvidence";
import {
  validateEnrichmentBatch,
  type ValidatedEnrichmentItem,
} from "./validateEnrichmentAnswer";

const enrichmentItemSchema = z.object({
  material_number: z
    .string()
    .describe("Exakt wie in der Evidenz, inkl. führender Nullen"),
  process_label: z
    .string()
    .nullable()
    .describe("Kurzer fachlicher Prozessname, max. 12 Wörter"),
  condition_summary: z
    .string()
    .nullable()
    .describe("Ein Satz: Wann greift diese Nummer?"),
  effect_summary: z
    .string()
    .nullable()
    .describe("Ein Satz: Was bewirkt der Treffer fachlich?"),
  process_claim_status: z.enum(["CODE_DERIVED", "INFERRED", "UNSUPPORTED"]),
  primary_object: z
    .string()
    .nullable()
    .describe("Ein object_name aus allowed_object_names"),
  grounded_on: z
    .array(z.enum(["snippet", "analysis", "mara", "object_name"]))
    .describe("Welche Evidenzteile genutzt wurden"),
});

const enrichmentBatchSchema = z.object({
  materials: z.array(enrichmentItemSchema),
  theme_sentence: z
    .string()
    .nullable()
    .describe("Ein Satz zu Themenclustern — ohne Anzahlen/Zahlen"),
});

export type HardcodedEnrichmentDiagnostics = {
  attempted: boolean;
  succeeded: boolean;
  batches: number;
  enriched_count: number;
  duration_ms: number;
  error: string | null;
  mara_hits?: number;
  analysis_hit_units?: number;
  validated_accepted?: number;
  validated_rejected?: number;
};

const ENRICH_TOP_N = 20;
const ENRICH_TIMEOUT_MS = 22_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(onTimeout());
      });
  });
}

function matKey(s: string): string {
  const t = s.trim();
  if (/^\d+$/.test(t)) return t.replace(/^0+/, "") || "0";
  return t.toUpperCase();
}

function evidenceLabel(
  claim: HardcodedMaterialCard["claim_status"],
  hasProcess: boolean,
  processStatus: "CODE_DERIVED" | "INFERRED" | "UNSUPPORTED" | null,
): string {
  if (processStatus === "UNSUPPORTED" || !hasProcess) {
    return claim === "AUTHORITATIVE"
      ? "Im Code belegt"
      : "Vorsichtige Einordnung";
  }
  if (processStatus === "INFERRED") {
    return "Im Code belegt / vorsichtige Prozesseinordnung";
  }
  return "Im Code belegt / Prozess aus Code abgeleitet";
}

function isPlaceholderMaterial(num: string): boolean {
  return /^0+$/.test(num.trim());
}

function buildExecutiveSummary(
  view: HardcodedValueAnswerView,
  theme: string | null,
  maraHits: number,
): string {
  const X = view.summary.unique_material_count;
  const Y = view.summary.active_occurrence_count;
  const base =
    X === 0
      ? view.summary.text
      : `Im kundeneigenen Code sind ${X} fest hinterlegte Materialnummern an ${Y} aktiven Stellen belegt. Unten finden Sie je Nummer den Prozessbezug, die Bedingung und die Auswirkung.`;
  const maraNote =
    maraHits > 0
      ? ` ${maraHits} dieser Nummern sind zusätzlich in den MARA-Stammdaten der Datenbasis nachweisbar.`
      : "";
  const t = theme?.trim();
  const themeOk =
    t && t.length > 20 && !/\d+\s*(Material|Fundstelle|Nummer)/i.test(t)
      ? ` ${t}`
      : "";
  return `${base}${maraNote}${themeOk}`.trim();
}

async function askOpenAiEnrichment(params: {
  question: string;
  packsJson: string;
  packCount: number;
}): Promise<z.infer<typeof enrichmentBatchSchema>> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 50_000,
    maxRetries: AI_CONFIG.maxRetries,
  });

  const system = [
    "Du bist SAP-Fachredakteur für Key-User. Sprache: Deutsch, klar, konkret.",
    "",
    "AUFGABE",
    "Formuliere zu jeder Materialnummer: process_label, condition_summary, effect_summary.",
    "",
    "EVIDENZ (verbindlich)",
    "Du erhältst je Nummer: master_data (MARA), code_hits (Snippet + optionale Methodenanalyse), allowed_object_names.",
    "Nutze NUR diese Evidenz. Keine Spekulation außerhalb.",
    "",
    "REGELN",
    "1) Materialkurztext/Bezeichnung gibt es NICHT (kein MAKT) — niemals erfinden.",
    "2) MTART/MATKL/MEINS nur nennen, wenn master_data.found_in_mara=true und der Wert gesetzt ist.",
    "3) primary_object MUSS in allowed_object_names stehen.",
    "4) process_claim_status:",
    "   - CODE_DERIVED: wenn code_hits[].analysis vorhanden und du sie nutzt",
    "   - INFERRED: nur Snippet/Objektkontext, vorsichtige Formulierung",
    "   - UNSUPPORTED: kein belastbarer Materialbezug",
    "5) grounded_on: alle genutzten Quellen auflisten (snippet/analysis/mara/object_name).",
    "6) Keine Floskeln wie „Verwendung im MATNR-Kontext“.",
    "7) Wenn mehrere Prozesse: den häufigsten nennen und „u. a.“ ergänzen.",
    "8) material_number exakt wie geliefert (führende Nullen).",
    "9) theme_sentence: ein Satz ohne Zahlen.",
    "10) Antworte für JEDE gelieferte material_number genau einmal.",
    "",
    "GUTE FORMULIERUNG",
    "process_label: „EDI-Auftragsposition Sonderbehandlung“",
    "condition_summary: „Wenn die Positionsmaterialnummer diesem festen Wert entspricht.“",
    "effect_summary: „Die Position wird im IDoc bzw. Folgeprozess gesondert behandelt.“",
  ].join("\n");

  const user = [
    `Nutzerfrage: ${params.question}`,
    "",
    "Arbeite ausschließlich mit dem folgenden Evidenzpaket aus der Datenbasis.",
    `Materialien in diesem Lauf: ${params.packCount} — alle beantworten.`,
    "",
    "EVIDENZPAKET:",
    params.packsJson,
  ].join("\n");

  const completion = await client.chat.completions.parse({
    model: AI_CONFIG.chatModel,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: zodResponseFormat(
      enrichmentBatchSchema,
      "hardcoded_material_enrichment_v3",
    ),
  });

  return enrichmentBatchSchema.parse(completion.choices[0]?.message?.parsed);
}

function processFromCardLocations(card: HardcodedMaterialCard): string | null {
  const blob = (card.occurrences ?? [])
    .filter((o) => o.active_code)
    .map((o) => `${o.object_name} ${o.unit_name}`)
    .join(" ")
    .toUpperCase();
  if (!blob) return null;
  if (/EDI|IDOC|ORDERS|DESADV|INVOIC|ORDRSP/.test(blob)) {
    return "EDI-/Belegverarbeitung";
  }
  if (/ATP|PRUEF|PRÜF/.test(blob)) return "ATP-/Verfügbarkeitsprüfung";
  if (/LAGER|VLAGER|BESTAND|TOUR|LADE/.test(blob)) {
    return "Lager-/Touren-/Bestandsprozess";
  }
  if (/FAKTUR|BILLING|INVOICE|KONDITION/.test(blob)) {
    return "Fakturierung / Konditionen";
  }
  if (/LIEF|DELIV|SHIP|LIPS|LIKP/.test(blob)) return "Lieferprozess";
  if (/LEERGUT|EMPTI/.test(blob)) return "Leergutprozess";
  return null;
}

function polishCondition(raw: string | null): string | null {
  if (!raw) {
    return "Das Material wird im Quellcode mit einem fest hinterlegten Wert verglichen.";
  }
  if (/Literalvergleich/i.test(raw) || /MATNR-Kontext/i.test(raw)) {
    return "Im Code steht ein direkter Vergleich bzw. eine Prüfung gegen diese fest hinterlegte Materialnummer.";
  }
  if (/Verzweigung/i.test(raw)) {
    return "Eine Programmverzweigung greift, wenn die Materialnummer diesem festen Wert entspricht.";
  }
  return raw;
}

function polishEffect(raw: string | null): string | null {
  if (!raw || /Verwendung im MATNR-Kontext/i.test(raw)) {
    return "Bei Treffer greift die im jeweiligen Programm hinterlegte Sonderlogik für dieses Material.";
  }
  if (/Aufnahme in Materialliste/i.test(raw)) {
    return "Die Nummer wird in eine fest hinterlegte Materialliste bzw. Range aufgenommen und steuert nachfolgende Prüfungen.";
  }
  if (/SELECT/i.test(raw)) {
    return "Die Nummer filtert eine Selektion bzw. Datenbankabfrage auf dieses Material.";
  }
  if (/Default|Konstantenwert/i.test(raw)) {
    return "Die Nummer dient als fest vorgegebener Standard- oder Konstantenwert für Materialfelder.";
  }
  if (/Zuweisung/i.test(raw)) {
    return "Die Nummer wird einem Materialfeld bzw. einer Materialkonstanten zugewiesen.";
  }
  return raw;
}

function applyValidated(
  card: HardcodedMaterialCard,
  hit: ValidatedEnrichmentItem | null,
): HardcodedMaterialCard {
  const fallbackProcess = card.process_label ?? processFromCardLocations(card);
  const polishedCondition = polishCondition(card.condition_summary);
  const polishedEffect = polishEffect(card.effect_summary);

  if (isPlaceholderMaterial(card.material_number)) {
    return {
      ...card,
      process_label: "Initial-/Leerwert für Material",
      condition_summary:
        "Wenn die Materialnummer initial ist bzw. nur aus Nullen besteht.",
      effect_summary:
        "Leere oder nicht gesetzte Materialfelder werden gesondert behandelt (Default, Filter oder Ausschluss).",
      evidence_status: "Im Code belegt / Prozess aus Code abgeleitet",
    };
  }

  if (!hit || !hit.accepted) {
    return {
      ...card,
      process_label: fallbackProcess,
      condition_summary: polishedCondition,
      effect_summary: polishedEffect,
      evidence_status: evidenceLabel(
        card.claim_status,
        Boolean(fallbackProcess),
        fallbackProcess ? "INFERRED" : null,
      ),
    };
  }

  return {
    ...card,
    process_label: hit.process_label || fallbackProcess,
    condition_summary: hit.condition_summary || polishedCondition,
    effect_summary: hit.effect_summary || polishedEffect,
    evidence_status: evidenceLabel(
      card.claim_status,
      Boolean(hit.process_label || fallbackProcess),
      hit.process_claim_status,
    ),
  };
}

function polishDeterministicCopy(
  view: HardcodedValueAnswerView,
): HardcodedValueAnswerView {
  const materials = view.materials.map((m) => ({
    ...m,
    condition_summary: polishCondition(m.condition_summary),
    effect_summary: polishEffect(m.effect_summary),
    evidence_status: evidenceLabel(
      m.claim_status,
      Boolean(m.process_label),
      m.process_label ? "CODE_DERIVED" : null,
    ),
  }));
  return {
    ...view,
    summary: {
      ...view.summary,
      text: buildExecutiveSummary(view, null, 0),
    },
    materials,
    multi_use: materials.filter((m) => m.occurrence_count >= 2),
  };
}

/**
 * Enrich material cards using Datenbasis evidence + grounded OpenAI wording.
 */
export async function enrichHardcodedValueAnswer(params: {
  question: string;
  view: HardcodedValueAnswerView;
  projectKey: string;
  analyses: Map<string, Record<string, unknown>>;
}): Promise<{
  view: HardcodedValueAnswerView;
  diagnostics: HardcodedEnrichmentDiagnostics;
}> {
  const started = Date.now();
  const base = params.view;
  if (base.materials.length === 0) {
    return {
      view: base,
      diagnostics: {
        attempted: false,
        succeeded: false,
        batches: 0,
        enriched_count: 0,
        duration_ms: 0,
        error: null,
      },
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      view: polishDeterministicCopy(base),
      diagnostics: {
        attempted: false,
        succeeded: false,
        batches: 0,
        enriched_count: 0,
        duration_ms: Date.now() - started,
        error: "OPENAI_API_KEY fehlt — deterministische Texte belassen",
      },
    };
  }

  const timeoutFallback = (): {
    view: HardcodedValueAnswerView;
    diagnostics: HardcodedEnrichmentDiagnostics;
  } => ({
    view: polishDeterministicCopy(base),
    diagnostics: {
      attempted: true,
      succeeded: false,
      batches: 0,
      enriched_count: 0,
      duration_ms: Date.now() - started,
      error: "Enrichment-Zeitlimit — deterministische Karten geliefert",
    },
  });

  return withTimeout(
    enrichHardcodedValueAnswerInner(params, started, base),
    ENRICH_TIMEOUT_MS,
    timeoutFallback,
  );
}

async function enrichHardcodedValueAnswerInner(
  params: {
    question: string;
    view: HardcodedValueAnswerView;
    projectKey: string;
    analyses: Map<string, Record<string, unknown>>;
  },
  started: number,
  base: HardcodedValueAnswerView,
): Promise<{
  view: HardcodedValueAnswerView;
  diagnostics: HardcodedEnrichmentDiagnostics;
}> {
  try {
    const priority = base.materials
      .filter((m) => !isPlaceholderMaterial(m.material_number))
      .slice(0, ENRICH_TOP_N);

    const prepared = await prepareHardcodedEvidence({
      projectKey: params.projectKey,
      cards: priority,
      analyses: params.analyses,
    });

    const packsJson = JSON.stringify({
      materials: prepared.packs.map((p) => ({
        material_number: p.material_number,
        occurrence_count: p.occurrence_count,
        evidence_strength: p.evidence_strength,
        master_data: p.master_data,
        allowed_object_names: p.allowed_object_names,
        code_hits: p.code_hits.map((h) => ({
          object_type: h.object_type,
          object_name: h.object_name,
          unit_name: h.unit_name,
          line_number: h.line_number,
          snippet: h.snippet,
          condition_hint: h.condition_hint,
          action_hint: h.action_hint,
          tables_fields: h.tables_fields,
          analysis: h.analysis
            ? {
                business_purpose: h.analysis.business_purpose,
                technical_summary: h.analysis.technical_summary,
                special_cases: h.analysis.special_cases,
                facts: h.analysis.facts,
                tables_read: h.analysis.tables_read,
                hardcoded_values: h.analysis.hardcoded_values,
                confidence: h.analysis.confidence,
              }
            : null,
        })),
      })),
    });

    const parsed = await askOpenAiEnrichment({
      question: params.question,
      packsJson,
      packCount: prepared.packs.length,
    });

    const validated = validateEnrichmentBatch(
      prepared.packs,
      parsed.materials.map((m) => ({
        material_number: m.material_number,
        process_label: m.process_label,
        condition_summary: m.condition_summary,
        effect_summary: m.effect_summary,
        process_claim_status: m.process_claim_status,
        primary_object: m.primary_object,
        grounded_on: m.grounded_on,
      })),
    );

    const byKey = new Map<string, ValidatedEnrichmentItem>();
    for (const v of validated) {
      byKey.set(matKey(v.material_number), v);
    }

    const materials = base.materials.map((card) =>
      applyValidated(card, byKey.get(matKey(card.material_number)) ?? null),
    );

    const accepted = validated.filter((v) => v.accepted).length;
    const rejected = validated.length - accepted;

    const missing: string[] = [];
    const withoutProcess = materials.filter((m) => !m.process_label).length;
    if (withoutProcess > 0) {
      missing.push(
        `Für ${withoutProcess} Materialnummer(n) ist der Geschäftsprozess aus den vorliegenden Code- und Stammdatenbelegen noch nicht eindeutig ableitbar.`,
      );
    }
    if (prepared.mara_hits < priority.length) {
      missing.push(
        `${priority.length - prepared.mara_hits} der priorisierten Nummern sind nicht in MARA hinterlegt (nur als Code-Literal belegt). Materialkurztexte (MAKT) fehlen in der Datenbasis generell.`,
      );
    }

    return {
      view: {
        ...base,
        summary: {
          ...base.summary,
          text: buildExecutiveSummary(
            base,
            parsed.theme_sentence,
            prepared.mara_hits,
          ),
        },
        materials,
        multi_use: materials.filter((m) => m.occurrence_count >= 2),
        comment_or_unclear: base.comment_or_unclear.map((c) => {
          const updated = materials.find(
            (m) => m.material_number_internal === c.material_number_internal,
          );
          return updated ?? c;
        }),
        missing_information: missing,
        sources: [
          ...base.sources,
          ...prepared.sources,
          "openai enrichment v3 (validated against Datenbasis evidence)",
        ],
      },
      diagnostics: {
        attempted: true,
        succeeded: true,
        batches: 1,
        enriched_count: accepted,
        duration_ms: Date.now() - started,
        error: null,
        mara_hits: prepared.mara_hits,
        analysis_hit_units: prepared.analysis_hit_units,
        validated_accepted: accepted,
        validated_rejected: rejected,
      },
    };
  } catch (e) {
    return {
      view: polishDeterministicCopy(base),
      diagnostics: {
        attempted: true,
        succeeded: false,
        batches: 0,
        enriched_count: 0,
        duration_ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      },
    };
  }
}
