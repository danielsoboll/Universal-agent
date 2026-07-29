# Phase-1-Bericht — General Agent

Datum: 2026-07-29  
Projekt: `pkcucpsrwgactejovdmp` (Universal-agent)  
Repo: `general-agent`

## Ausgeführte Migrationen / Seeds

| Schritt | Ergebnis |
|---|---|
| `supabase db push --linked` → `20260729000100_init_schema.sql` | erfolgreich |
| `supabase/seed.sql` | erfolgreich (2 Systemprofile, 13 SAP-Tasks) |
| HNSW-Migration | **nicht** ausgeführt (nur `supabase/planned/…`) |

## Tabellen (public)

`projects`, `project_members`, `sources`, `documents`, `knowledge_units`, `entities`, `knowledge_unit_entities`, `relations`, `source_profiles`, `analysis_profiles`, `analysis_tasks`, `analysis_runs`, `analysis_results`, `result_sources`, `chat_sessions`, `chat_messages`, `knowledge_unit_reviews`, `processing_jobs`, `ai_usage_logs`

Alle mit **RLS = true**.

## Extensions

- `vector`
- `pgcrypto`

## Storage

- Bucket `source-originals` — **privat**
- Policies: select/insert/update/delete (`source_originals_*`)

## Policies

- 49 Policies im Schema `public`
- 4 Storage-Policies auf `storage.objects`
- Kein `using (true)` für authenticated Fachdaten
- Helper: `is_project_member` / `can_edit_project` / `is_project_owner` (aktive Mitgliedschaft)

## App (Phase 1)

Implementiert:

- Supabase Browser- + Server-Client + Admin (service role, server-only)
- Middleware mit Session-Refresh und Auth-Gate
- Login / Logout (E-Mail + Passwort)
- Projektübersicht, anlegen, öffnen, Rollenanzeige
- Source-Upload in privaten Storage (`{project_id}/{source_id}/…`)
- Processing-Job-Platzhalter
- Chat-Session + User-Nachricht (Viewer erlaubt)

Noch nicht: OpenAI, Embeddings, Parser, KU-Erzeugung, Retrieval, Analyseberichte

## Sicherheitstests

Script: `scripts/security-tests.ts` → **13 / 13 PASS**

| Test | Ergebnis |
|---|---|
| anon ohne projects | PASS |
| ohne Mitgliedschaft kein fremdes Projekt | PASS |
| Viewer liest + Chat | PASS |
| Viewer kein Source-Insert | PASS |
| Editor Sources + Jobs | PASS |
| Editor kein KU-/Result-Write | PASS |
| Owner Mitgliederverwaltung | PASS |
| fremde project_id blockiert | PASS |
| fremdes Storage nicht lesbar | PASS |
| Service-Role nicht im Client-Modul | PASS |

Testbenutzer (Auth Admin, nur Dev):

- `owner.phase1@general-agent.test`
- `editor.phase1@general-agent.test`
- `viewer.phase1@general-agent.test`

## Build

`npm run build` — **erfolgreich** (Next.js 16.2.12)

Hinweis: Next warnt, dass `middleware` zugunsten von `proxy` deprecated ist.

## Environment-Variablen

| Variable | Ort | Client? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `.env.local` | ja |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `.env.local` | ja |
| `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` | **nein** |
| `DATABASE_URL` | optional / Platzhalter | nein |
| `OPENAI_API_KEY` | noch leer | nein |

Vorlage: `.env.example` (keine Secrets committed).

## Offene Risiken

1. `DATABASE_URL` noch mit Passwort-Platzhalter — CLI nutzt derzeit Linked Login Role.
2. Middleware→Proxy-Migration in Next 16 ausstehend.
3. Form-Actions werfen bei Fehlern (keine polished Error-UI).
4. Projektlöschung mit paginiertem Storage-Cleanup noch nicht als App-Flow gebaut (nur dokumentiert).
5. Internes Testsystem — keine Freigabe für DGL-Produktivdaten.
6. Build-Warnung/Deprecation beobachten.

## Nächster sinnvoller Schritt

**Phase 2:** Extraktion/Segmentierung (TXT/MD/JSON/JSONL/CSV/PDF) als Job-Worker mit `service_role`, Statusfortschritt, Knowledge Units erzeugen — weiterhin ohne freie Client-Mutation der Units.
