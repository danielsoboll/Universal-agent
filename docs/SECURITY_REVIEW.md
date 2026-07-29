# Security Review — General Agent

Stand: Schema/RLS im Repo finalisiert für die genannten Entscheidungen, **noch nicht ausgeführt**.

## Freigabestatus / Datenklassifizierung

- Dieses System ist zunächst ein **internes Testsystem**.
- **DGL-Produktivdaten** dürfen erst nach **organisatorischer Freigabe** verarbeitet werden.
- Vor Produktivbetrieb sind zu prüfen: **OpenAI- und Supabase-Verträge**, **Datenregion**, **Aufbewahrung**, **Löschung** und **Datenklassifizierung**.
- **Originaldateien und KI-Ausgaben bleiben getrennt** (`original_content` vs. `prepared_content` / Review-Tabellen).
- **KI-Aussagen sind keine fachlich freigegebenen Tatsachen.** Fachliche Korrekturen erfolgen über Reviews, nicht durch Überschreiben des Originals oder der KI-Ausgabe.

## Auth (V1)

- Supabase Auth: **E-Mail + Passwort**
- Ein oder wenige manuell angelegte Testbenutzer
- Keine öffentliche Registrierung

## Rollenmatrix

Zugriff nur bei **aktiver** `project_members`-Zeile (`is_active = true`).

| Aktion | viewer | editor | owner |
|---|---|---|---|
| Projekt / Quellen / Units / Analysen / Chat **lesen** | ja | ja | ja |
| Chat-Frage stellen (Session + `role=user` Message) | **ja** | ja | ja |
| Quellen hochladen / ändern / Storage löschen | nein | ja | ja |
| Verarbeitungs- / Analysejobs **starten** | nein | ja | ja |
| Documents / Knowledge Units / Entities / Results **schreiben** | nein* | nein* | nein* |
| Reviews (`knowledge_unit_reviews`) schreiben | nein | ja | ja |
| `ai_usage_logs` lesen | nein | nein | **ja** |
| Mitglieder / Rollen | nein | nein | **ja** |
| Projekt löschen | nein | nein | **ja** |

\* Schreiben ausschließlich über **serverseitige** Verarbeitung mit `service_role`.

| Rolle | Hinweis |
|---|---|
| `anon` | keine App-Policies |
| `authenticated` | nur RLS wie oben |
| `service_role` | nur Server (Pipeline, Assistant-Chat, Usage-Logs, signierte URLs, Seed) |

## Betroffene RLS-Policies (Kernänderungen)

| Objekt | authenticated |
|---|---|
| `documents`, `knowledge_units`, `entities`, `knowledge_unit_entities`, `relations` | **SELECT** (Member) — kein Insert/Update/Delete |
| `analysis_results`, `result_sources` | **SELECT** (Member) — kein Write |
| `analysis_runs` | SELECT; INSERT (Editor/Owner start); DELETE Owner; Update nur Server |
| `processing_jobs` | SELECT; INSERT start; DELETE Owner; Update nur Server |
| `chat_sessions` | SELECT/INSERT Member; Update/Delete Editor/Owner |
| `chat_messages` | SELECT Member; INSERT Member nur `role = 'user'`; Delete Editor/Owner |
| `knowledge_unit_reviews` | SELECT Member; CUD Editor/Owner (`reviewer_id = auth.uid()`) |
| `ai_usage_logs` | SELECT nur **Owner**; kein Client-Write |
| `sources` + Storage | wie zuvor: Member lesen; Editor/Owner schreiben/löschen |
| Helper | `is_project_member` / `can_edit` / `is_project_owner` verlangen `is_active = true` |
| `projects` SELECT | `owner_id = auth.uid()` **oder** aktives Membership — nötig, damit `INSERT … RETURNING` vor dem AFTER-Trigger greift |

## Review-Struktur

Tabelle `knowledge_unit_reviews`:

- `project_id`, `knowledge_unit_id` (Composite-FK)
- `reviewer_id`, `status` (`pending|approved|rejected|needs_correction`)
- `rating`, `comment`, `correction_notes`, `metadata`
- Zweck: Bewertung/Freigabe/Korrekturhinweise **ohne** Änderung von `original_content` oder `prepared_content`

## Embeddings

- V1: `vector(1536)` für `text-embedding-3-small`
- Modellwechsel ⇒ Migration + Re-Embedding
- **HNSW** geplant in Phase 4 (`migrations/planned/...hnsw.sql`), nicht in Phase 1

## Seed

- `supabase/seed.sql` einmalig serverseitig (SQL Editor / CLI)
- Keine Client-Funktion

## Finaler Projektlöschablauf (Server, Owner)

1. Owner-Berechtigung prüfen.
2. Löschjob anlegen / Status `running` protokollieren (wiederholbar).
3. Storage Prefix `{project_id}/` in `source-originals` **paginiert** listen und löschen.
4. Nach jeder Seite Fortschritt/Fehler speichern (Teilfehler ⇒ Job `failed`/`retryable`, erneut ab Prefix fortsetzbar).
5. Abschließend erneut listen: Prefix muss **leer** sein. Sonst abbrechen und protokollieren.
6. Erst dann `DELETE FROM projects WHERE id = …` (DB-Cascade).
7. Job `completed` setzen.

Einzelne Source: analog Prefix `{project_id}/{source_id}/`, dann Source-Zeile löschen.

## Serverseitige Geheimnisse

- `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `OPENAI_API_KEY` — nie Client
- Client: nur URL + Publishable Key

## Verbleibende Risiken

1. Unvollständige Storage-Löschung ohne Verify-Schritt
2. Falsche Nutzung von Secret Key im Client
3. Reviews können fachlich irreführen, wenn UI KI-Text und Review nicht klar trennt
4. Internes Testsystem ≠ Freigabe für DGL-Produktivdaten
5. HNSW/Performance erst mit Volumen relevant
