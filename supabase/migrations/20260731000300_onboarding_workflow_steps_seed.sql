-- =============================================================================
-- Workflow step template seeds (SAP / Documents / Generic)
-- =============================================================================

-- Clear & reinsert steps for known templates (idempotent by unique step_key)
delete from public.workflow_step_templates
where workflow_template_id in (
  'd1111111-1111-4111-8111-111111111101',
  'd1111111-1111-4111-8111-111111111102',
  'd1111111-1111-4111-8111-111111111103'
);

-- ---- SAP Knowledge Reconstruction ----
insert into public.workflow_step_templates (
  workflow_template_id, step_key, phase_key, title, short_description, detailed_instructions, info_text,
  sort_order, required, completion_type, pipeline_step_key, adapter_key,
  visible_when, prerequisites, expected_outputs, estimated_effort_text, responsible_role
) values
(
  'd1111111-1111-4111-8111-111111111101',
  'prep_project_kickoff',
  'vorbereitung',
  'Projekt und Ansprechpartner festlegen',
  'Verantwortlichkeiten und Scope-Rahmen klären.',
  'Benennen Sie Customer Admin, fachliche Ansprechpartner und den Systemkontakt. Dokumentieren Sie, welche Systeme in Scope sind.',
  'Was: Kickoff und Rollen. Warum: ohne klare Verantwortung bleibt der Fahrplan stecken. Ergebnis: benannte Ansprechpartner. Fertig wenn: Namen und Erreichbarkeit hinterlegt.',
  10, true, 'manual_checkbox', null, null,
  '{}'::jsonb, '[]'::jsonb, '["Rollenliste"]'::jsonb, '30–60 Min', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'prep_security_clearance',
  'vorbereitung',
  'Datenschutz- und Exportfreigabe einholen',
  'Freigabe für Exporte und Uploads sicherstellen.',
  'Klären Sie mit Datenschutz/IT-Security, welche Objekte und Tabelleninhalte exportiert werden dürfen.',
  'Was: Freigabe. Warum: Uploads ohne Freigabe sind riskant. Ergebnis: schriftliche Freigabe. Fertig wenn: Freigabe dokumentiert.',
  20, true, 'manual_checkbox', null, null,
  '{}'::jsonb, '["prep_project_kickoff"]'::jsonb, '["Freigabenotiz"]'::jsonb, '1–3 Tage', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'goal_confirm_scope',
  'ziel_und_scope',
  'Zielsetzung und Scope bestätigen',
  'Gewählte Ziele und Adapter gegenprüfen.',
  'Prüfen Sie die im Wizard gewählten Ziele. Entfernen Sie Quellen, die nicht freigegeben sind.',
  'Was: Scope-Freeze. Warum: verhindert Scope Creep. Ergebnis: bestätigte Ziel- und Adapterliste. Fertig wenn: Checklisteneintrag gesetzt.',
  30, true, 'configuration_completed', null, null,
  '{}'::jsonb, '["prep_security_clearance"]'::jsonb, '["Scope-Dokument"]'::jsonb, '30 Min', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'systems_register_landscape',
  'systeme_und_quellen',
  'Systeme und Landschaft dokumentieren',
  'System-ID, Mandant und Umgebung erfassen.',
  'Tragen Sie System-ID, Umgebung und Mandant in der Adapterkonfiguration ein.',
  'Was: Systemstammdaten. Warum: Exporte und Läufe brauchen eindeutige Systembezüge. Ergebnis: ausgefüllte Adapterkonfiguration. Fertig wenn: Pflichtfelder gesetzt.',
  40, true, 'configuration_completed', null, 'sap_abap_repository',
  '{"all_adapters":["sap_abap_repository"]}'::jsonb,
  '["goal_confirm_scope"]'::jsonb, '["Systemkonfiguration"]'::jsonb, '30 Min', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'export_prepare_report',
  'datenexport',
  'Exportreport im Quellsystem vorbereiten',
  'Exportmechanismus im Quellsystem anlegen oder prüfen.',
  'Stellen Sie sicher, dass der vereinbarte Exportreport bzw. die Extraktion im Quellsystem verfügbar ist.',
  'Was: Export vorbereiten. Warum: ohne stabilen Export keine reproduzierbaren Uploads. Ergebnis: lauffähiger Export. Fertig wenn: Testdatei erzeugt.',
  50, true, 'manual_checkbox', null, 'sap_abap_repository',
  '{"all_adapters":["sap_abap_repository"]}'::jsonb,
  '["systems_register_landscape"]'::jsonb, '["Testexport"]'::jsonb, '2–8 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'export_classes',
  'datenexport',
  'Klassen-/Repository-Export durchführen',
  'ABAP-Repository gemäß Filter exportieren.',
  'Führen Sie den Repository-Export mit den konfigurierten Namensräumen/Paketen aus.',
  'Was: Code exportieren. Warum: Basis für Code Units. Ergebnis: Exportarchiv. Fertig wenn: Datei vollständig und lesbar.',
  60, true, 'manual_checkbox', null, 'sap_abap_repository',
  '{"all_adapters":["sap_abap_repository"]}'::jsonb,
  '["export_prepare_report"]'::jsonb, '["Repository-Export"]'::jsonb, '1–4 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'export_control_tables_inventory',
  'datenexport',
  'Steuertabellen ohne Inhalt inventarisieren',
  'Tabellenliste ohne Zeileninhalt erzeugen.',
  'Exportieren Sie das Inventar aller relevanten Steuertabellen (Metadaten).',
  'Was: Inventar. Warum: auch Tabellen ohne Inhalt sind für Relationen wichtig. Ergebnis: Inventar-JSONL. Fertig wenn: Datei validiert.',
  70, true, 'manual_checkbox', null, 'sap_control_tables',
  '{"all_adapters":["sap_control_tables"]}'::jsonb,
  '["systems_register_landscape"]'::jsonb, '["Tabelleninventar"]'::jsonb, '1–2 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'export_control_tables_content',
  'datenexport',
  'Steuertabellen mit Inhalt exportieren',
  'Freigegebene Tabelleninhalte exportieren.',
  'Exportieren Sie nur freigegebene Tabellen inklusive Zeilen. Maskieren Sie personenbezogene Felder.',
  'Was: Inhaltsexport. Warum: Parameterwirkungen brauchen konkrete Werte. Ergebnis: Rows-JSONL. Fertig wenn: Freigabe und Datei ok.',
  80, false, 'manual_checkbox', null, 'sap_control_tables',
  '{"all_adapters":["sap_control_tables"]}'::jsonb,
  '["export_control_tables_inventory"]'::jsonb, '["Tabelleninhalt"]'::jsonb, '2–6 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'upload_validate_repository',
  'upload_und_validierung',
  'Repository-Datei hochladen und validieren',
  'Upload mit Schema-/Formatprüfung.',
  'Laden Sie den Repository-Export hoch. Die Validierung prüft Format und grundlegende Vollständigkeit.',
  'Was: Upload+Validierung. Warum: fehlerhafte Dateien blockieren Kanonisierung. Ergebnis: status validated. Fertig wenn: Validierung ohne Blocker.',
  90, true, 'file_uploaded', null, 'sap_abap_repository',
  '{"all_adapters":["sap_abap_repository"]}'::jsonb,
  '["export_classes"]'::jsonb, '["Validierungsbericht"]'::jsonb, '30 Min', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'upload_validate_tables',
  'upload_und_validierung',
  'Steuertabellen-Dateien hochladen und validieren',
  'Inventar und ggf. Inhalt hochladen.',
  'Laden Sie Inventar und freigegebene Inhalte hoch und prüfen Sie die Validierungsmeldung.',
  'Was: Tabellen-Upload. Warum: Pipeline braucht kanonisierbare Eingaben. Ergebnis: validated Uploads. Fertig wenn: keine Schemafehler.',
  100, true, 'file_uploaded', null, 'sap_control_tables',
  '{"all_adapters":["sap_control_tables"]}'::jsonb,
  '["export_control_tables_inventory"]'::jsonb, '["Validierungsbericht"]'::jsonb, '30 Min', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'canon_code_units',
  'kanonisierung',
  'Code Units kanonisieren',
  'Rohdaten in kanonische Code Units überführen.',
  'Starten Sie den freigegebenen Pipeline-Schritt zur Kanonisierung. Ohne realen Lauf bleibt der Status ready/configured.',
  'Was: Kanonisierung Code. Warum: einheitliche source_keys. Ergebnis: canonical code_units. Fertig wenn: Pipeline succeeded.',
  110, true, 'pipeline_success', 'canonicalize.sap_classes', 'sap_abap_repository',
  '{"all_adapters":["sap_abap_repository"]}'::jsonb,
  '["upload_validate_repository"]'::jsonb, '["canonical/classes"]'::jsonb, 'je nach Volumen', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'canon_control_tables',
  'kanonisierung',
  'Steuertabellen kanonisieren',
  'Inventar/Rows in kanonische Tabellenform bringen.',
  'Starten Sie die Tabellen-Kanonisierung nach erfolgreichem Upload.',
  'Was: Kanonisierung Tabellen. Warum: Relationen brauchen stabile Keys. Ergebnis: canonical control-tables. Fertig wenn: Pipeline succeeded.',
  120, true, 'pipeline_success', 'canonicalize.control_tables', 'sap_control_tables',
  '{"all_adapters":["sap_control_tables"]}'::jsonb,
  '["upload_validate_tables"]'::jsonb, '["canonical/control-tables"]'::jsonb, 'je nach Volumen', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'analyze_code_units',
  'analyse_und_interpretation',
  'Code Units analysieren',
  'Strukturierte Analysen mit Evidence erzeugen.',
  'Nur starten, wenn freigegeben und konfiguriert. Keine Analyse ohne expliziten Auftrag.',
  'Was: Code-Analyse. Warum: Facts/Inferences für Suche. Ergebnis: unit_analyses. Fertig wenn: Quality Gate ok.',
  130, true, 'pipeline_success', 'analyze.sap_code_units', 'sap_abap_repository',
  '{"all_adapters":["sap_abap_repository"],"any_goals":["code_intelligence","knowledge_reconstruction","migration_analysis"]}'::jsonb,
  '["canon_code_units"]'::jsonb, '["analyses/classes"]'::jsonb, 'kostenpflichtig', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'link_code_tables',
  'verknuepfung_und_relationen',
  'Code-Tabellen-Relationen erzeugen',
  'Zugriffe zwischen Code und Steuertabellen verknüpfen.',
  'Erzeugt deterministische Verknüpfungen. Interpretation optional separat.',
  'Was: Relationen. Warum: Steuerwirkungen nachvollziehbar. Ergebnis: link-/relations-Artefakte. Fertig wenn: Pipeline succeeded.',
  140, true, 'pipeline_success', 'link.code_control_tables', 'sap_control_tables',
  '{"all_adapters":["sap_abap_repository","sap_control_tables"]}'::jsonb,
  '["canon_code_units","canon_control_tables"]'::jsonb, '["relations"]'::jsonb, 'je nach Volumen', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'index_search_documents',
  'indexierung',
  'SearchDocuments bauen',
  'Generische Suchdokumente aus Artefakten erzeugen.',
  'Baut den lokalen/produktiven Suchkorpus. Keine Chat-Antworten.',
  'Was: SearchDocuments. Warum: Grundlage Hybrid Search. Ergebnis: search_documents. Fertig wenn: Index-Schritt ok.',
  150, true, 'pipeline_success', 'index.search', null,
  '{"any_goals":["enterprise_search","knowledge_reconstruction","code_intelligence"]}'::jsonb,
  '["analyze_code_units"]'::jsonb, '["indexes/search"]'::jsonb, 'je nach Volumen', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'quality_evidence_check',
  'qualitaetssicherung',
  'Evidence-Qualität prüfen',
  'Prüfen, ob Aussagen auf Belege zurückführen.',
  'Kontrollieren Sie Stichproben: Facts vs Inferences, Evidence-Refs auflösbar.',
  'Was: QS Evidence. Warum: Anwender brauchen Belege. Ergebnis: QS-Notiz. Fertig wenn: Gate passed oder manuell bestätigt.',
  160, true, 'quality_gate_passed', null, null,
  '{}'::jsonb, '["analyze_code_units"]'::jsonb, '["quality_report"]'::jsonb, '1–2 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'quality_retrieval_eval',
  'qualitaetssicherung',
  'Retrieval-Evaluation erfolgreich',
  'Testfragen gegen den Index prüfen.',
  'Führen Sie den Evaluationskatalog aus und prüfen Sie Recall.',
  'Was: Retrieval-Test. Warum: Freigabe nur bei ausreichender Suchequalität. Ergebnis: Eval-Report. Fertig wenn: Mindestrecall erreicht.',
  170, true, 'quality_gate_passed', null, null,
  '{"any_goals":["enterprise_search","knowledge_reconstruction","code_intelligence"]}'::jsonb,
  '["index_search_documents"]'::jsonb, '["evaluate_search_report"]'::jsonb, '1 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'release_app_access',
  'freigabe_fuer_anwender',
  'Anwenderzugriff freigeben',
  'Anwenderbereich für customer_user öffnen.',
  'Erst freigeben, wenn Qualitätsschritte erledigt sind. Schaltet den App-Bereich frei.',
  'Was: Freigabe. Warum: Anwender sollen nur geprüfte Bestände sehen. Ergebnis: status active + Freigabeschritt completed. Fertig wenn: Approval gesetzt.',
  180, true, 'approval', null, null,
  '{}'::jsonb, '["quality_evidence_check"]'::jsonb, '["app_release"]'::jsonb, '15 Min', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111101',
  'ops_update_policy',
  'betrieb_und_aktualisierung',
  'Aktualisierungsrhythmus festlegen',
  'Wann werden Exporte und Indizes erneuert?',
  'Definieren Sie den Rhythmus für Re-Exports und Re-Indexierung.',
  'Was: Betriebsmodell. Warum: Wissen veraltet sonst. Ergebnis: Update-Policy. Fertig wenn: Rhythmus dokumentiert.',
  190, false, 'manual_checkbox', null, null,
  '{}'::jsonb, '["release_app_access"]'::jsonb, '["ops_policy"]'::jsonb, '30 Min', 'customer_admin'
);

-- ---- Document Knowledge Base ----
insert into public.workflow_step_templates (
  workflow_template_id, step_key, phase_key, title, short_description, detailed_instructions, info_text,
  sort_order, required, completion_type, pipeline_step_key, adapter_key,
  visible_when, prerequisites, expected_outputs, estimated_effort_text, responsible_role
) values
(
  'd1111111-1111-4111-8111-111111111102',
  'doc_prep_sources',
  'vorbereitung',
  'Dokumentquellen vorbereiten',
  'Freigegebene Dokumentenmengen festlegen.',
  'Listen Sie freigegebene Dokumentquellen und Verantwortliche.',
  'Was: Quellenliste. Warum: Upload braucht klaren Scope. Ergebnis: Quellenliste. Fertig wenn: Liste bestätigt.',
  10, true, 'manual_checkbox', null, 'documents',
  '{}'::jsonb, '[]'::jsonb, '["Quellenliste"]'::jsonb, '1 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111102',
  'doc_upload',
  'upload_und_validierung',
  'Dokumente hochladen',
  'Dateien in den kundenspezifischen Storage laden.',
  'Laden Sie PDF/DOCX gemäß Freigabe hoch.',
  'Was: Upload. Warum: ohne Dateien keine Extraktion. Ergebnis: Uploads. Fertig wenn: Dateien validated.',
  20, true, 'file_uploaded', null, 'documents',
  '{}'::jsonb, '["doc_prep_sources"]'::jsonb, '["Uploads"]'::jsonb, 'variabel', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111102',
  'doc_extract',
  'kanonisierung',
  'Text- und Abschnittsextraktion',
  'Dokumente in Abschnitte überführen.',
  'Extraktion vorbereiten; realer Lauf nur wenn Pipeline verfügbar.',
  'Was: Extraktion. Warum: Suche braucht Abschnitte. Ergebnis: Segmente. Fertig wenn: Extraktion ok oder ready.',
  30, true, 'pipeline_success', null, 'documents',
  '{}'::jsonb, '["doc_upload"]'::jsonb, '["Segmente"]'::jsonb, 'variabel', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111102',
  'doc_analyze',
  'analyse_und_interpretation',
  'Dokumente analysieren',
  'Optionale strukturierte Aufbereitung.',
  'Nur mit Freigabe und vorhandenem Analyse-Schritt.',
  'Was: Analyse. Warum: bessere Auffindbarkeit. Ergebnis: Analysen. Fertig wenn: Lauf succeeded.',
  40, false, 'pipeline_success', null, 'documents',
  '{}'::jsonb, '["doc_extract"]'::jsonb, '["Analysen"]'::jsonb, 'kostenpflichtig', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111102',
  'doc_index',
  'indexierung',
  'SearchDocuments bauen',
  'Suchkorpus aus Dokumenten erzeugen.',
  'Indexschritt starten, sobald Extraktion vorliegt.',
  'Was: Index. Warum: Anwendersuche. Ergebnis: SearchDocuments. Fertig wenn: Index ok.',
  50, true, 'pipeline_success', 'index.search', null,
  '{}'::jsonb, '["doc_extract"]'::jsonb, '["indexes/search"]'::jsonb, 'variabel', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111102',
  'doc_retrieval_test',
  'qualitaetssicherung',
  'Retrieval-Test',
  'Stichprobenfragen prüfen.',
  'Definieren Sie 5–10 Fachfragen und prüfen Sie Treffer.',
  'Was: Test. Warum: Freigabequalität. Ergebnis: Testnotiz. Fertig wenn: akzeptable Treffer.',
  60, true, 'quality_gate_passed', null, null,
  '{}'::jsonb, '["doc_index"]'::jsonb, '["retrieval_notes"]'::jsonb, '1 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111102',
  'doc_release',
  'freigabe_fuer_anwender',
  'Anwenderzugriff freigeben',
  'App-Bereich freischalten.',
  'Freigabe nur nach erfolgreichem Retrieval-Test.',
  'Was: Freigabe. Warum: kontrollierter Go-Live. Ergebnis: Freigabe. Fertig wenn: Approval.',
  70, true, 'approval', null, null,
  '{}'::jsonb, '["doc_retrieval_test"]'::jsonb, '["app_release"]'::jsonb, '15 Min', 'customer_admin'
);

-- ---- Generic multi-source ----
insert into public.workflow_step_templates (
  workflow_template_id, step_key, phase_key, title, short_description, detailed_instructions, info_text,
  sort_order, required, completion_type, pipeline_step_key, adapter_key,
  visible_when, prerequisites, expected_outputs, estimated_effort_text, responsible_role
) values
(
  'd1111111-1111-4111-8111-111111111103',
  'gen_kickoff',
  'vorbereitung',
  'Mehrquellen-Projekt vorbereiten',
  'Ziele und Quellen priorisieren.',
  'Priorisieren Sie Adapter und klären Sie Freigaben je Quelle.',
  'Was: Kickoff. Warum: Mehrquellen brauchen Reihenfolge. Ergebnis: Prioritätenliste. Fertig wenn: bestätigt.',
  10, true, 'manual_checkbox', null, null,
  '{}'::jsonb, '[]'::jsonb, '["Prioritäten"]'::jsonb, '1 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111103',
  'gen_configure_adapters',
  'systeme_und_quellen',
  'Adapter konfigurieren',
  'Konfiguration je gewähltem Adapter ausfüllen.',
  'Füllen Sie die configuration_schema-Felder je Adapter aus.',
  'Was: Konfiguration. Warum: Läufe brauchen Parameter. Ergebnis: konfigurierte Adapter. Fertig wenn: Pflichtfelder ok.',
  20, true, 'configuration_completed', null, null,
  '{}'::jsonb, '["gen_kickoff"]'::jsonb, '["Adapterkonfiguration"]'::jsonb, '1–2 Std', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111103',
  'gen_upload',
  'upload_und_validierung',
  'Quellen hochladen und validieren',
  'Uploads je Adapter.',
  'Laden Sie die Exporte hoch und prüfen Sie Validierungsergebnisse.',
  'Was: Upload. Warum: Eingangsqualität. Ergebnis: validated files. Fertig wenn: keine Blocker.',
  30, true, 'file_uploaded', null, null,
  '{}'::jsonb, '["gen_configure_adapters"]'::jsonb, '["Uploads"]'::jsonb, 'variabel', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111103',
  'gen_index',
  'indexierung',
  'SearchDocuments und Index aufbauen',
  'Gemeinsamen Suchindex erzeugen.',
  'Sobald Quellen vorbereitet sind, Index aufbauen.',
  'Was: Index. Warum: unternehmensweite Suche. Ergebnis: Index. Fertig wenn: Schritt ok.',
  40, true, 'pipeline_success', 'index.search', null,
  '{}'::jsonb, '["gen_upload"]'::jsonb, '["indexes/search"]'::jsonb, 'variabel', 'customer_admin'
),
(
  'd1111111-1111-4111-8111-111111111103',
  'gen_release',
  'freigabe_fuer_anwender',
  'Anwenderzugriff freigeben',
  'Freigabe nach Stichprobentest.',
  'Geben Sie den Anwenderbereich erst nach einem kurzen Retrieval-Check frei.',
  'Was: Freigabe. Warum: kontrollierter Start. Ergebnis: Freigabe. Fertig wenn: Approval.',
  50, true, 'approval', null, null,
  '{}'::jsonb, '["gen_index"]'::jsonb, '["app_release"]'::jsonb, '15 Min', 'customer_admin'
);
