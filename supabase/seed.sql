-- =============================================================================
-- General Agent — system profile seeds
-- SEPARATE from migrations. Apply once, server-side only:
--   - Supabase SQL Editor (service role / postgres), or
--   - Supabase CLI against the linked project
-- No client/UI seed path exists and must not be added in V1.
-- Idempotent via fixed UUIDs + ON CONFLICT / targeted DELETE.
-- =============================================================================

-- Fixed IDs for stable references in app config / docs
-- Analysis profiles
--   a1111111-1111-4111-8111-111111111101  Allgemeiner Wissensassistent
--   a1111111-1111-4111-8111-111111111102  SAP Custom Code Scan

insert into public.analysis_profiles (
  id,
  name,
  description,
  mode,
  source_types,
  system_prompt,
  rules,
  retrieval_configuration,
  output_configuration,
  is_system,
  created_by
) values (
  'a1111111-1111-4111-8111-111111111101',
  'Allgemeiner Wissensassistent',
  'Beantwortet Nutzerfragen ausschließlich auf Grundlage der gefundenen Projektquellen.',
  'chat',
  '[]'::jsonb,
  $prompt$
Du bist ein Wissensassistent für projektinterne Quellen.
Antworte ausschließlich auf Grundlage der gelieferten Fundstellen.
Trenne Quelleninhalt und Interpretation klar.
Erfinde keine Aussagen.
Nenne passende Quellen mit nachvollziehbaren Bezügen.
Sage ausdrücklich, wenn die Daten keine ausreichende Antwort liefern.
Behalte Fachbegriffe der Quelle bei.
$prompt$,
  jsonb_build_array(
    'Nur aus gelieferten Quellen antworten',
    'Quelleninhalt und Interpretation trennen',
    'Keine erfundenen Aussagen',
    'Quellen nennen',
    'Unzureichende Daten klar benennen',
    'Fachbegriffe der Quelle beibehalten'
  ),
  jsonb_build_object(
    'preferExactForTechnicalTerms', true,
    'defaultMaxUnits', 12,
    'includeDebugSearchPlan', false
  ),
  jsonb_build_object(
    'format', 'markdown',
    'requireCitations', true
  ),
  true,
  null
)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  mode = excluded.mode,
  source_types = excluded.source_types,
  system_prompt = excluded.system_prompt,
  rules = excluded.rules,
  retrieval_configuration = excluded.retrieval_configuration,
  output_configuration = excluded.output_configuration,
  is_system = true,
  created_by = null,
  updated_at = now();

insert into public.analysis_profiles (
  id,
  name,
  description,
  mode,
  source_types,
  system_prompt,
  rules,
  retrieval_configuration,
  output_configuration,
  is_system,
  created_by
) values (
  'a1111111-1111-4111-8111-111111111102',
  'SAP Custom Code Scan',
  'Chat- und Batch-Analyse für SAP-bezogene Knowledge Units. Technische Feststellung, Ableitung und Vermutung strikt trennen.',
  'both',
  '["jsonl", "sap_abap", "txt", "markdown"]'::jsonb,
  $prompt$
Du analysierst SAP-Custom-Code und zugehörige Fundstellen.
Trenne strikt:
1) technisch belegt
2) aus dem Code stark ableitbar
3) plausible fachliche Vermutung
4) nicht feststellbar
Kennzeichne auskommentierten Code gesondert.
Bewerte reine Deklarationen nicht als Geschäftslogik.
Berücksichtige Programmnamen, Kommentare, Tabellen, Felder, IDoc-Segmente und feste Werte gemeinsam.
Nenne Geschäftsprozesse nur mit Konfidenz und Begründung.
Erfinde keine Kundennamen oder Anforderungen.
Mache offene fachliche Fragen sichtbar.
Gib Fundstellen immer an.
$prompt$,
  jsonb_build_array(
    'Technische Feststellungen, Ableitungen und Vermutungen trennen',
    'Auskommentierten Code kennzeichnen',
    'Deklarationen nicht als Geschäftslogik werten',
    'Programme, Kommentare, Tabellen, Felder, IDocs und Konstanten gemeinsam betrachten',
    'Prozesse nur mit Konfidenz und Begründung',
    'Keine erfundenen Kunden oder Anforderungen',
    'Offene Fragen sichtbar machen',
    'Fundstellen immer angeben'
  ),
  jsonb_build_object(
    'preferExactForTechnicalTerms', true,
    'exactTermBoost', 2.0,
    'defaultMaxUnits', 20,
    'includeRelatedUnits', true
  ),
  jsonb_build_object(
    'format', 'markdown',
    'requireCitations', true,
    'certaintyLevels', jsonb_build_array(
      'technisch_belegt',
      'ableitbar',
      'vermutung',
      'nicht_feststellbar'
    )
  ),
  true,
  null
)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  mode = excluded.mode,
  source_types = excluded.source_types,
  system_prompt = excluded.system_prompt,
  rules = excluded.rules,
  retrieval_configuration = excluded.retrieval_configuration,
  output_configuration = excluded.output_configuration,
  is_system = true,
  created_by = null,
  updated_at = now();

-- Remove previous seeded tasks for SAP profile (idempotent re-seed)
delete from public.analysis_tasks
where analysis_profile_id = 'a1111111-1111-4111-8111-111111111102'
  and id in (
    'b1111111-1111-4111-8111-111111111201',
    'b1111111-1111-4111-8111-111111111202',
    'b1111111-1111-4111-8111-111111111203',
    'b1111111-1111-4111-8111-111111111204',
    'b1111111-1111-4111-8111-111111111205',
    'b1111111-1111-4111-8111-111111111206',
    'b1111111-1111-4111-8111-111111111207',
    'b1111111-1111-4111-8111-111111111208',
    'b1111111-1111-4111-8111-111111111209',
    'b1111111-1111-4111-8111-111111111210',
    'b1111111-1111-4111-8111-111111111211',
    'b1111111-1111-4111-8111-111111111212',
    'b1111111-1111-4111-8111-111111111213'
  );

insert into public.analysis_tasks (
  id,
  analysis_profile_id,
  name,
  description,
  sort_order,
  query_template,
  exact_terms,
  metadata_filters,
  retrieval_strategy,
  prompt_template,
  output_schema,
  enabled
) values
(
  'b1111111-1111-4111-8111-111111111201',
  'a1111111-1111-4111-8111-111111111102',
  'Geschäftsregeln erkennen',
  'Identifiziere fachliche Regeln und Bedingungen im Custom Code.',
  1,
  'Geschäftsregeln Bedingungen IF CASE Prüfungen Custom Code',
  '["IF", "CASE", "CHECK", "ASSERT"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Extrahiere Geschäftsregeln. Trenne belegt / ableitbar / Vermutung. Nenne Fundstellen.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111202',
  'a1111111-1111-4111-8111-111111111102',
  'Kundenspezifische Sonderlogik erkennen',
  'Finde kundenspezifische Abweichungen und Sonderwege.',
  2,
  'kundenspezifisch Sonderlogik Z-Programm Custom Enhancement',
  '["USER-EXIT", "BAdI", "Enhancement", "Z"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Identifiziere kundenspezifische Sonderlogik mit Evidenz und Unsicherheit.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111203',
  'a1111111-1111-4111-8111-111111111102',
  'Schnittstellen erkennen',
  'Erkenne RFC, IDoc, File, HTTP und andere Schnittstellen.',
  3,
  'Schnittstelle Interface RFC IDoc ALE HTTP File',
  '["CALL FUNCTION", "RFC", "IDoc", "HTTP", "FTP"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Liste Schnittstellenkandidaten mit Typ, Konfidenz und Fundstellen.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111204',
  'a1111111-1111-4111-8111-111111111102',
  'IDoc-Verarbeitung erkennen',
  'Finde IDoc-Typen, Segmente und Mapping-Logik.',
  4,
  'IDoc Segment DESADV E1EDP Mapping',
  '["IDoc", "EDI_DOCNUM", "EDIDC", "EDIDD", "DESADV"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Beschreibe IDoc-Verarbeitung technisch belegt und fachlich vorsichtig.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111205',
  'a1111111-1111-4111-8111-111111111102',
  'Hart codierte Werte erkennen',
  'Finde Literale, feste Codes und Magic Values.',
  5,
  'hart codiert Konstante Literal Magic Value',
  '["CONSTANTS", "VALUE", "HAWA"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Liste hart codierte Werte mit Kontext und Risiko.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111206',
  'a1111111-1111-4111-8111-111111111102',
  'Direkte Datenänderungen erkennen',
  'Finde UPDATE, INSERT, DELETE, MODIFY auf Tabellen.',
  6,
  'UPDATE INSERT DELETE MODIFY Datenänderung',
  '["UPDATE", "INSERT", "DELETE", "MODIFY"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Liste direkte Datenänderungen mit Tabelle und Fundstelle.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111207',
  'a1111111-1111-4111-8111-111111111102',
  'Verwendete Materialstammfelder erkennen',
  'Finde Bezüge zu MARA und Materialfeldern.',
  7,
  'Materialstamm MARA MTART MATNR Feld',
  '["MARA", "MTART", "MATNR", "MARC"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Liste verwendete Materialstammfelder mit Nutzungscharakter.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111208',
  'a1111111-1111-4111-8111-111111111102',
  'Weitere Stammdatenabhängigkeiten erkennen',
  'Finde Kunden-, Lieferanten-, Organisations- und andere Stammdaten.',
  8,
  'Stammdaten KNA1 LFA1 VBAK VBRP Organisation',
  '["KNA1", "LFA1", "VBAK", "VBAP", "VBRP", "LIKP", "LIPS"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Liste Stammdatenabhängigkeiten mit Evidenz.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111209',
  'a1111111-1111-4111-8111-111111111102',
  'Technische Risiken erkennen',
  'Finde Risiken wie harte Updates, fehlende Sperren, Legacy-Muster.',
  9,
  'Risiko Performance Sperre Legacy Dump',
  '["SELECT *", "FOR ALL ENTRIES", "COMMIT", "CALL TRANSACTION"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Bewerte technische Risiken mit Schwere und Fundstellen.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111210',
  'a1111111-1111-4111-8111-111111111102',
  'Auskommentierte oder vermutlich veraltete Logik erkennen',
  'Finde auskommentierten oder tot wirkenden Code.',
  10,
  'auskommentiert obsolete alt TODO FIXME',
  '["*", "\"", "TODO", "FIXME", "obsolete"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Liste auskommentierte oder vermutlich veraltete Logik getrennt von aktiver Logik.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111211',
  'a1111111-1111-4111-8111-111111111102',
  'Prozesse und SAP-Module zuordnen',
  'Ordne Fundstellen möglichen Prozessen und Modulen zu.',
  11,
  'Prozess Modul SD MM FI CO WM',
  '["SD", "MM", "FI", "CO", "WM", "LE"]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Ordne Prozesse und Module nur mit Konfidenz und Begründung zu.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111212',
  'a1111111-1111-4111-8111-111111111102',
  'Offene fachliche Klärungspunkte erstellen',
  'Sammle offene Fragen für Fachbereich und IT.',
  12,
  'offene Frage Klärung unsicher Annahme',
  '[]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Erstelle eine Liste offener fachlicher Klärungspunkte ohne Spekulation als Fakt.',
  '{}'::jsonb,
  true
),
(
  'b1111111-1111-4111-8111-111111111213',
  'a1111111-1111-4111-8111-111111111102',
  'Management Summary erzeugen',
  'Erzeuge eine kurze Management-Zusammenfassung aus den bisherigen Ergebnissen.',
  13,
  'Management Summary Überblick Risiken Handlungsbedarf',
  '[]'::jsonb,
  '{}'::jsonb,
  'hybrid',
  'Erzeuge eine Management Summary. Trenne Fakten, Ableitungen und offene Punkte.',
  '{}'::jsonb,
  true
);
