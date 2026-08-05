import { createHash } from "crypto";
import type { DomainProfileId } from "@/lib/domain/types";
import { QUERY_PLAN_SCHEMA_VERSION } from "@/lib/knowledge/queryPlanSchema";

/**
 * Prompt Registry — version catalog for pipeline + ask prompts.
 * Domain-specific ask prompts live here; SAP texts must not leak into other profiles.
 */

export type PromptRegistryEntry = {
  prompt_id: string;
  version: string;
  /** Logical owner module (documentation / resolution hint). */
  module: string;
  /** Structured-output schema name when applicable. */
  schema_name?: string;
  /** Free-text status for ops. */
  status: "active" | "reserved" | "deprecated";
  description: string;
  /** null = domain-agnostic base prompt. */
  domain_profile_id?: DomainProfileId | null;
  /** Prompt body when resolved from this registry (ask prompts). */
  body?: string;
  created_at?: string;
  hash?: string;
};

function withHash(
  entry: Omit<PromptRegistryEntry, "hash"> & { body: string },
): PromptRegistryEntry {
  const hash = createHash("sha256").update(entry.body).digest("hex").slice(0, 16);
  return { ...entry, hash };
}

export const QUERY_PLANNER_BASE_BODY = `Du bist ein Query Planner für ein unternehmensinternes
Wissens- und Reverse-Engineering-System.

Deine einzige Aufgabe ist, eine Nutzerfrage in einen strukturierten Suchplan
zu überführen.

Du beantwortest die Fachfrage nicht.
Du erfindest keine Fakten.
Du ergänzt keine technischen Objekte, die nicht aus der Frage hervorgehen.
Du darfst sprachliche Varianten, Synonyme und allgemein gültige Suchkonzepte
bilden.

Regeln:

1. Gib ausschließlich gültiges JSON gemäß dem vorgegebenen Schema zurück.
2. Keine Markdown-Blöcke.
3. Keine Erläuterung außerhalb des JSON.
4. Keine Antwort auf die Nutzerfrage.
5. Keine Annahme als Fakt formulieren.
6. Unklare Punkte unter "ambiguities" aufführen.
7. Subqueries müssen unterschiedliche Suchaspekte abdecken.
8. Maximal 4 Subqueries.
9. Keine konkrete technische Entität erfinden.
10. Relationserweiterung nur anfordern, wenn sie zur Frage passt.
11. required_evidence muss ausdrücken, welche Belegarten für eine belastbare
    Antwort benötigt werden.
12. planner_confidence zwischen 0 und 1.
13. schema_version muss genau "${QUERY_PLAN_SCHEMA_VERSION}" sein.
14. Verwende ausschließlich die im User-Prompt gelisteten Intent-, Entity- und Target-Typen.
15. Die Originalfrage wird separat als Basissuche ausgeführt — Subqueries müssen
    ergänzende Aspekte abdecken, nicht die Originalfrage ersetzen oder paraphrasieren.`;

export const ANSWER_SYNTHESIZER_BASE_BODY = `Du bist ein Assistent für belegbare Antworten aus einem indexierten Wissensbestand.

Du lieferst ZWEI getrennte Bereiche im JSON-Schema:

A) process_answer — für fachliche Anwender (Prozessantwort).
   Felder:
   - summary: kurz was umgesetzt ist / Wirkung (nur wenn belastbar)
   - statements[]: jede Aussage mit level + source_ranks
       * confirmed = direkt quellenbelegt (Fakten/Code/Daten) — OHNE Vermutung
       * inferred = abgeleitet; Formulierungen wie „Vermutlich…“, „Das deutet darauf hin…“
       * possible = unsicher — landet unter Offen
   - open_items[]: was offen / nicht belegt ist
   - has_safe_process_claim=true nur wenn mindestens eine confirmed Prozessaussage existiert

   Inhaltlich in den statements abdecken (wenn belegt): was implementiert, warum/wann,
   Prozesswirkung. Nicht als confirmed: vollständiger Geschäftszweck, Organisationsziele,
   Prozessoptimierung, Vermeidung falscher Bestellungen, Segmentierung zur internen
   Steuerung, Kundenarchitektur — höchstens inferred, sonst open_items.

   Wenn kein sicherer Prozessclaim möglich: has_safe_process_claim=false,
   summary kurz sagen dass der technische Mechanismus teilweise belegt ist, der
   vollständige fachliche Hintergrund aber nicht dokumentiert ist — NICHT erfinden.
   Antworte nicht länger durch Spekulation.

B) technical_answer — kompakte Technische Antwort (unter der Prozessantwort).
   Abschnitte (je statements mit level + source_ranks):
   entry_point, trigger, processing, objects, results, relations, open
   Nur Wesentliches; keine vollständigen Quellendumps. Scores/Tokens/Planner gehören
   nicht hierher.

Zusätzlich technical_details.conditions / changed_fields / additional_evidence_notes
für serverseitige Ergänzung — nichts erfinden.

Evidence-Levels (intern): confirmed | inferred | possible.
not_supported/contradicted nie als positive Aussage. Nur confirmed als sichere Fakten;
inferred sprachlich markieren; possible nur als Offen.

Du erhältst Entity-Grounding und einen strukturierten Evidence-Kontext.
Entity-Grounding ist bindend.

Regeln (streng):
- Ausschließlich aus den bereitgestellten Quellen der aktuellen Frage.
- Keine Vorfragen, kein Chat-Gedächtnis, keine allgemeinen Produktkenntnisse.
- Keine Aussage verlängern durch Halluzination.
- Jede confirmed-Aussage MUSS source_ranks haben, die den Claim stützen.
- FACT in Quellen → confirmed möglich; INFERENCE in Quellen → höchstens inferred.
- ENTITY-GROUNDING IST BINDEND:
  1. Regel/Hardcoding nur auf Query-Entität anwenden wenn Grounding confirmed/possible.
  2. contradicted/not_found: nicht übertragen; klar sagen dass kein spezifischer Beleg vorliegt.
  3. Ähnliche andere Entität nur getrennt als nicht anwendbar (open_items), nie als Antwort.
  4. Rein technische Frage ohne benannte Entität: technisch erklären; Quellwerte nicht
     einer nicht genannten Entität zuschreiben.
  5. insufficient_evidence=true wenn benannte Query-Entität contradicted/not_found
     oder Quellen sonst nicht reichen.
- Vergleichsfragen: beide Seiten prüfen; wenn nur eine Seite belegt → ehrlich sagen.
  Bei Optitool alt/neu: wenn Quellen ZOTCO_IMPORT / OT_UPDATE_CUSTOMER (alt) und
  ZCO_IMPORT_NEW* / OT_UPDATE_CUSTOMER_NEW (neu) enthalten, beide Seiten nennen —
  nicht nur eine Hilfsmethode (z. B. nur UPLOAD_OPTO_INPUT), sofern die Paare belegt sind.
- source_ranks_used = alle Ränge die du für Kernclaims genutzt hast.
- Sprache: Deutsch. Fehlendes weglassen, nie erfinden.`;

const ASK_PROMPTS: PromptRegistryEntry[] = [
  withHash({
    prompt_id: "query_planner.base",
    version: "v1",
    module: "src/lib/core/promptRegistry.ts",
    status: "active",
    description: "Generic query planner system prompt",
    domain_profile_id: null,
    created_at: "2026-07-31",
    body: QUERY_PLANNER_BASE_BODY,
  }),
  withHash({
    prompt_id: "query_planner.sap",
    version: "v1",
    module: "src/lib/domain/profiles/sap.ts",
    status: "active",
    description: "SAP planner domain extension",
    domain_profile_id: "sap",
    created_at: "2026-07-31",
    body:
      "Domäne: SAP (ABAP-Code, Steuertabellen, Kunden-/Partner-Sonderlogik). " +
      "Entitäten wie Kundennummer, Partnerrolle, Material, Werk sind SAP-Stammdaten-Begriffe.",
  }),
  withHash({
    prompt_id: "query_planner.website",
    version: "v1",
    module: "src/lib/domain/profiles/generic.ts",
    status: "active",
    description: "Website planner domain extension",
    domain_profile_id: "website",
    created_at: "2026-07-31",
    body: "Domäne: Webseite. Entitäten sind Themen, Seiten und Inhalte.",
  }),
  withHash({
    prompt_id: "query_planner.database",
    version: "v1",
    module: "src/lib/domain/profiles/generic.ts",
    status: "active",
    description: "Database planner domain extension",
    domain_profile_id: "database",
    created_at: "2026-07-31",
    body: "Domäne: Datenbank. Entitäten sind Tabellen, Spalten und Datensätze.",
  }),
  withHash({
    prompt_id: "query_planner.sharepoint",
    version: "v1",
    module: "src/lib/domain/profiles/generic.ts",
    status: "active",
    description: "SharePoint planner domain extension",
    domain_profile_id: "sharepoint",
    created_at: "2026-07-31",
    body:
      "Domäne: SharePoint. Entitäten sind Dokumente, Listen und Metadaten.",
  }),
  withHash({
    prompt_id: "query_planner.generic_documents",
    version: "v1",
    module: "src/lib/domain/profiles/generic.ts",
    status: "active",
    description: "Generic documents planner extension",
    domain_profile_id: "generic_documents",
    created_at: "2026-07-31",
    body:
      "Domäne: Allgemeine Dokumente. Keine domänenspezifischen Entitätstypen — bleib generisch.",
  }),
  withHash({
    prompt_id: "answer_synthesizer.base",
    version: "v2",
    module: "src/lib/core/promptRegistry.ts",
    status: "active",
    description: "Answer synthesizer with process/tech evidence contract",
    domain_profile_id: null,
    created_at: "2026-08-02",
    body: ANSWER_SYNTHESIZER_BASE_BODY,
  }),
  withHash({
    prompt_id: "answer_synthesizer.sap",
    version: "v1",
    module: "src/lib/domain/profiles/sap.ts",
    status: "active",
    description: "SAP answer domain extension",
    domain_profile_id: "sap",
    created_at: "2026-07-31",
    body:
      "Domäne: SAP. Quellen sind Code-Units (Klasse/Methode), Steuertabellenzeilen " +
      "und deren Verknüpfungen. Kundenspezifische Sonderlogik ist häufig an " +
      "Kunden-/Partnernummern in Tabellen oder Hardcodings im Code gebunden.",
  }),
  withHash({
    prompt_id: "answer_synthesizer.website",
    version: "v1",
    module: "src/lib/domain/profiles/generic.ts",
    status: "active",
    description: "Website answer domain extension",
    domain_profile_id: "website",
    created_at: "2026-07-31",
    body: "Domäne: Webseite. Quellen sind Seiten-/Inhaltsauszüge.",
  }),
  withHash({
    prompt_id: "answer_synthesizer.database",
    version: "v1",
    module: "src/lib/domain/profiles/generic.ts",
    status: "active",
    description: "Database answer domain extension",
    domain_profile_id: "database",
    created_at: "2026-07-31",
    body: "Domäne: Datenbank. Quellen sind Tabellen-/Datensatzauszüge.",
  }),
  withHash({
    prompt_id: "answer_synthesizer.sharepoint",
    version: "v1",
    module: "src/lib/domain/profiles/generic.ts",
    status: "active",
    description: "SharePoint answer domain extension",
    domain_profile_id: "sharepoint",
    created_at: "2026-07-31",
    body: "Domäne: SharePoint. Quellen sind Dokument-/Listenauszüge.",
  }),
  withHash({
    prompt_id: "answer_synthesizer.generic_documents",
    version: "v1",
    module: "src/lib/domain/profiles/generic.ts",
    status: "active",
    description: "Generic documents answer extension",
    domain_profile_id: "generic_documents",
    created_at: "2026-07-31",
    body:
      "Domäne: Allgemeine Dokumente. Quellen sind generische Dokumentauszüge.",
  }),
];

const PIPELINE_PROMPTS: PromptRegistryEntry[] = [
  {
    prompt_id: "unit_analysis",
    version: "unit-analysis-v4",
    module: "src/lib/analysis/unitAnalysisPrompt.ts",
    schema_name: "sap_code_unit_analysis_v4",
    status: "active",
    description: "ABAP code-unit structured analysis",
    domain_profile_id: "sap",
  },
  {
    prompt_id: "unit_analysis",
    version: "unit-analysis-v3",
    module: "src/lib/analysis/unitAnalysisPrompt.ts",
    status: "deprecated",
    description: "Previous code-unit analysis prompt",
    domain_profile_id: "sap",
  },
  {
    prompt_id: "control_table_analysis",
    version: "control-table-analysis-v1",
    module: "src/lib/analysis/controlTablePrompt.ts",
    schema_name: "sap_control_table_analysis_v1",
    status: "reserved",
    description: "Reserved — do not auto-run; pilot may use separately",
    domain_profile_id: "sap",
  },
  {
    prompt_id: "code_table_interpretation",
    version: "code-table-interpretation-v1",
    module: "src/lib/analysis/codeTableInterpretationPrompt.ts",
    schema_name: "code_table_interpretation_v1",
    status: "reserved",
    description: "Reserved joint code+table interpretation",
    domain_profile_id: "sap",
  },
];

export const PROMPT_REGISTRY: readonly PromptRegistryEntry[] = [
  ...PIPELINE_PROMPTS,
  ...ASK_PROMPTS,
];

export function listPromptVersions(promptId: string): PromptRegistryEntry[] {
  return PROMPT_REGISTRY.filter((e) => e.prompt_id === promptId);
}

export function resolvePromptEntry(
  promptId: string,
  version: string,
): PromptRegistryEntry {
  const entry = PROMPT_REGISTRY.find(
    (e) => e.prompt_id === promptId && e.version === version,
  );
  if (!entry) {
    throw new Error(
      `Prompt nicht in Registry: ${promptId}@${version}. Bekannt: ${PROMPT_REGISTRY.map(
        (e) => `${e.prompt_id}@${e.version}`,
      ).join(", ")}`,
    );
  }
  return entry;
}

export function activePromptVersion(promptId: string): string {
  const active = PROMPT_REGISTRY.find(
    (e) => e.prompt_id === promptId && e.status === "active",
  );
  if (!active) {
    throw new Error(`Keine active Prompt-Version für ${promptId}`);
  }
  return active.version;
}

export type ResolvedAskPrompt = {
  key: string;
  version: string;
  hash: string;
  domain_profile_id: DomainProfileId | null;
  text: string;
};

/** Compose base + domain extension for query planner. */
export function resolveQueryPlannerPrompt(params: {
  domainPromptKey: string;
  domainPromptVersion: string;
  domainExtensionFallback?: string;
}): ResolvedAskPrompt {
  const base = resolvePromptEntry("query_planner.base", "v1");
  const domain = resolvePromptEntry(
    params.domainPromptKey,
    params.domainPromptVersion,
  );
  const domainBody =
    domain.body?.trim() || params.domainExtensionFallback?.trim() || "";
  const text = [base.body ?? "", domainBody].filter(Boolean).join("\n\n");
  return {
    key: `${base.prompt_id}.${base.version}+${domain.prompt_id}.${domain.version}`,
    version: `${base.version}+${domain.version}`,
    hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
    domain_profile_id: domain.domain_profile_id ?? null,
    text,
  };
}

/** Compose base + domain extension for answer synthesizer. */
export function resolveAnswerSynthesizerPrompt(params: {
  domainPromptKey: string;
  domainPromptVersion: string;
  domainExtensionFallback?: string;
  extraRules?: string;
}): ResolvedAskPrompt {
  const base = resolvePromptEntry("answer_synthesizer.base", "v2");
  const domain = resolvePromptEntry(
    params.domainPromptKey,
    params.domainPromptVersion,
  );
  const domainBody =
    domain.body?.trim() || params.domainExtensionFallback?.trim() || "";
  const text = [base.body ?? "", domainBody, params.extraRules ?? ""]
    .filter(Boolean)
    .join("\n\n");
  return {
    key: `${base.prompt_id}.${base.version}+${domain.prompt_id}.${domain.version}`,
    version: `${base.version}+${domain.version}`,
    hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
    domain_profile_id: domain.domain_profile_id ?? null,
    text,
  };
}
