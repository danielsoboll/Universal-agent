-- =============================================================================
-- Onboarding catalog seeds (goal templates, adapters, workflow templates)
-- Idempotent fixed UUIDs. Safe to re-run.
-- =============================================================================

-- Goal templates
insert into public.goal_templates (
  id, goal_type, title, description, meaning_text, outcomes_text, typical_sources_text, sort_order, enabled
) values
(
  'b1111111-1111-4111-8111-111111111101',
  'knowledge_reconstruction',
  'Unternehmenswissen rekonstruieren',
  'Bestehende Fach- und Systemkenntnisse aus Quellen wiederauffindbar machen.',
  'Ziel ist, verstreutes Wissen aus Systemen und Dokumenten in nachvollziehbare Wissenseinheiten zu überführen.',
  'Durchsuchbare Knowledge Units, belegbare Zusammenhänge, freigegebene Anwendersuche.',
  'Repository-Exporte, Steuertabellen, Dokumente, Tabellenkalkulationen.',
  10,
  true
),
(
  'b1111111-1111-4111-8111-111111111102',
  'code_intelligence',
  'Quellcode und Sonderlogik verstehen',
  'Technische Sonderpfade, Parameter und Abhängigkeiten im Code sichtbar machen.',
  'Sie wollen verstehen, welche Methoden welche Tabellen lesen/schreiben und welche Regeln gelten.',
  'Code-Analysen, Code-Tabellen-Relationen, Business Rules, Evidence-Bezüge.',
  'Quellcode-Repository, Steuertabellen mit/ohne Inhalt.',
  20,
  true
),
(
  'b1111111-1111-4111-8111-111111111103',
  'migration_analysis',
  'Migration oder Ablösung vorbereiten',
  'Abhängigkeiten und Risiken vor einem Systemwechsel strukturiert erfassen.',
  'Vor einer Ablösung brauchen Sie belastbare Inventare und Wirkungsketten.',
  'Inventar, Abhängigkeitsgraph, offene Risiken, Migrationshinweise.',
  'Code, Customizing, Prozessdokumente, Schnittstellenbeschreibungen.',
  30,
  true
),
(
  'b1111111-1111-4111-8111-111111111104',
  'enterprise_search',
  'Verschiedene Unternehmensquellen gemeinsam durchsuchen',
  'Eine hybride Suche über mehrere Quelltypen hinweg aufbauen.',
  'Anwender sollen über eine Oberfläche in mehreren Quellen suchen können.',
  'SearchDocuments, Embeddings, Hybrid-Search, Retrieval-Evaluation.',
  'Beliebige freigegebene Adapterquellen nach Kanonisierung und Indexierung.',
  40,
  true
),
(
  'b1111111-1111-4111-8111-111111111105',
  'process_documentation',
  'Prozesse dokumentieren',
  'Abläufe und Verantwortlichkeiten aus Quellen ableiten und pflegen.',
  'Prozesswissen soll belegbar und aktuell gehalten werden.',
  'Prozessbeschreibungen mit Quellenbezug.',
  'Dokumente, Tickets, Fachkonzepte.',
  50,
  true
),
(
  'b1111111-1111-4111-8111-111111111106',
  'risk_analysis',
  'Risiken und Abhängigkeiten erkennen',
  'Kritische Stellen, fehlende Evidence und ungelöste Zugriffe sichtbar machen.',
  'Qualität und Risiken sollen vor der Freigabe messbar sein.',
  'Quality Gates, offene Findings, dynamische unresolved Zugriffe.',
  'Analysen, Relationen, Evaluationsberichte.',
  60,
  true
)
on conflict (goal_type) do update set
  title = excluded.title,
  description = excluded.description,
  meaning_text = excluded.meaning_text,
  outcomes_text = excluded.outcomes_text,
  typical_sources_text = excluded.typical_sources_text,
  sort_order = excluded.sort_order,
  enabled = excluded.enabled,
  updated_at = now();

-- Input adapters
insert into public.input_adapters (
  id, adapter_key, name, description, adapter_category, enabled, availability_status,
  capabilities, configuration_schema,
  data_needed_text, detection_text, export_form_text, privacy_text, sort_order
) values
(
  'c1111111-1111-4111-8111-111111111101',
  'sap_abap_repository',
  'SAP Repository / ABAP',
  'Klassen, Methoden und verwandte Repository-Objekte.',
  'sap',
  true,
  'available',
  '{"reads_code":true,"produces_code_units":true}'::jsonb,
  '{
    "type":"object",
    "properties":{
      "system_id":{"type":"string","title":"System-ID"},
      "environment":{"type":"string","title":"Umgebung","enum":["DEV","QAS","PRD","OTHER"]},
      "client":{"type":"string","title":"Mandant"},
      "namespaces":{"type":"string","title":"Namensräume (Komma-getrennt)"},
      "package_filter":{"type":"string","title":"Paketfilter"},
      "export_types":{"type":"array","title":"Exporttypen","items":{"type":"string"}},
      "line_limit":{"type":"integer","title":"Zeilenlimit (optional)"},
      "language":{"type":"string","title":"Sprache","default":"DE"}
    },
    "required":["system_id"]
  }'::jsonb,
  'ABAP-Klassen-/Methodenexport aus dem Quellsystem.',
  'Code Units, Methodenaufrufe, Tabellenzugriffe, Evidence-Zeilen.',
  'JSONL/ZIP gemäß Adapter-Exportformat.',
  'Keine Produktivpasswörter; personenbezogene Daten in Codekommentaren prüfen.',
  10
),
(
  'c1111111-1111-4111-8111-111111111102',
  'sap_control_tables',
  'SAP Steuer- und Customizingtabellen',
  'Steuertabellen mit oder ohne Inhalt.',
  'sap',
  true,
  'available',
  '{"reads_tables":true,"produces_table_rows":true}'::jsonb,
  '{
    "type":"object",
    "properties":{
      "system_id":{"type":"string","title":"System-ID"},
      "client":{"type":"string","title":"Mandant"},
      "include_content":{"type":"boolean","title":"Inhalt exportieren","default":true},
      "table_filter":{"type":"string","title":"Tabellenfilter"},
      "row_limit":{"type":"integer","title":"Zeilenlimit je Tabelle"}
    },
    "required":["system_id"]
  }'::jsonb,
  'Tabelleninventar und optional Zeileninhalte.',
  'Canonical Rows, Control-Table-Analysen, Parameterwirkungen.',
  'JSONL für Inventar und Rows.',
  'Nur freigegebene Tabellen; personenbezogene Felder maskieren.',
  20
),
(
  'c1111111-1111-4111-8111-111111111103',
  'sap_master_data',
  'SAP Stammdaten',
  'Stammdatenauszüge für Kontext und Suche.',
  'sap',
  true,
  'planned',
  '{"reads_master_data":true}'::jsonb,
  '{"type":"object","properties":{"system_id":{"type":"string","title":"System-ID"}}}'::jsonb,
  'Freigegebene Stammdatensegmente.',
  'Entitäten und Suche über Stammdaten.',
  'CSV/JSONL.',
  'Datenschutz und Löschkonzepte beachten.',
  30
),
(
  'c1111111-1111-4111-8111-111111111104',
  'documents',
  'Dokumente / PDF',
  'Fachkonzepte, Handbücher, Protokolle.',
  'documents',
  true,
  'available',
  '{"reads_documents":true}'::jsonb,
  '{"type":"object","properties":{"language":{"type":"string","title":"Hauptsprache","default":"DE"}}}'::jsonb,
  'PDF/DOCX/TXT.',
  'Abschnitte, Zusammenfassungen, Quellenbelege.',
  'Datei-Upload in kundengetrenntem Storage.',
  'Vertrauliche Dokumente nur mit Freigabe.',
  40
),
(
  'c1111111-1111-4111-8111-111111111105',
  'spreadsheets',
  'Excel / Tabellen',
  'Listen, Mappings, Inventare.',
  'documents',
  true,
  'available',
  '{"reads_spreadsheets":true}'::jsonb,
  '{"type":"object","properties":{"sheet_filter":{"type":"string","title":"Blattfilter"}}}'::jsonb,
  'XLSX/CSV.',
  'Strukturierte Zeilen als Knowledge Units.',
  'Datei-Upload.',
  'Keine Klartext-Geheimnisse in Tabellen.',
  50
),
(
  'c1111111-1111-4111-8111-111111111106',
  'tickets',
  'Tickets',
  'Incidents und Change-Tickets als Kontext.',
  'collaboration',
  true,
  'planned',
  '{"reads_tickets":true}'::jsonb,
  '{"type":"object","properties":{"system_name":{"type":"string","title":"Ticket-System"}}}'::jsonb,
  'Ticket-Export ohne interne Kommentare mit PII, soweit möglich.',
  'Problemhistorie und Change-Bezüge.',
  'JSON/CSV Export.',
  'Personenbezogene Felder anonymisieren.',
  60
),
(
  'c1111111-1111-4111-8111-111111111107',
  'email',
  'E-Mail',
  'Freigegebene Mailarchive.',
  'collaboration',
  true,
  'planned',
  '{"reads_email":true}'::jsonb,
  '{"type":"object","properties":{}}'::jsonb,
  'Freigegebene Postfächer/Exports.',
  'Thread- und Entscheidungswissen.',
  'mbox/EML.',
  'DSGVO und Aufbewahrung prüfen.',
  70
),
(
  'c1111111-1111-4111-8111-111111111108',
  'source_code_generic',
  'Weiterer Quellcode',
  'Nicht-SAP-Repositories.',
  'code',
  true,
  'planned',
  '{"reads_code":true}'::jsonb,
  '{"type":"object","properties":{"language":{"type":"string","title":"Hauptsprache"}}}'::jsonb,
  'Git-Archiv oder Dateibaum.',
  'Code Units und Abhängigkeiten.',
  'ZIP/JSONL.',
  'Secrets in Repos scannen.',
  80
)
on conflict (adapter_key) do update set
  name = excluded.name,
  description = excluded.description,
  adapter_category = excluded.adapter_category,
  enabled = excluded.enabled,
  availability_status = excluded.availability_status,
  capabilities = excluded.capabilities,
  configuration_schema = excluded.configuration_schema,
  data_needed_text = excluded.data_needed_text,
  detection_text = excluded.detection_text,
  export_form_text = excluded.export_form_text,
  privacy_text = excluded.privacy_text,
  sort_order = excluded.sort_order,
  updated_at = now();

-- Workflow templates
insert into public.workflow_templates (
  id, template_key, name, description, version,
  goal_types, required_adapter_keys, optional_adapter_keys, enabled, priority
) values
(
  'd1111111-1111-4111-8111-111111111101',
  'sap_knowledge_reconstruction',
  'SAP Knowledge Reconstruction',
  'Fahrplan für Repository- und Steuertabellen-basiertes Wissensprojekt.',
  '1.0.0',
  '["knowledge_reconstruction","code_intelligence","migration_analysis","enterprise_search"]'::jsonb,
  '["sap_abap_repository"]'::jsonb,
  '["sap_control_tables","sap_master_data"]'::jsonb,
  true,
  10
),
(
  'd1111111-1111-4111-8111-111111111102',
  'document_knowledge_base',
  'Document Knowledge Base',
  'Fahrplan für dokumentenbasierte Wissensbasis.',
  '1.0.0',
  '["knowledge_reconstruction","enterprise_search","process_documentation"]'::jsonb,
  '["documents"]'::jsonb,
  '["spreadsheets","tickets"]'::jsonb,
  true,
  20
),
(
  'd1111111-1111-4111-8111-111111111103',
  'generic_multi_source',
  'Generic Multi-Source Knowledge Project',
  'Generischer Mehrquellen-Fahrplan, wenn keine spezialisierte Vorlage greift.',
  '1.0.0',
  '["knowledge_reconstruction","enterprise_search","custom","risk_analysis"]'::jsonb,
  '[]'::jsonb,
  '["documents","spreadsheets","tickets","source_code_generic","sap_abap_repository","sap_control_tables"]'::jsonb,
  true,
  100
)
on conflict (template_key, version) do update set
  name = excluded.name,
  description = excluded.description,
  goal_types = excluded.goal_types,
  required_adapter_keys = excluded.required_adapter_keys,
  optional_adapter_keys = excluded.optional_adapter_keys,
  enabled = excluded.enabled,
  priority = excluded.priority,
  updated_at = now();
