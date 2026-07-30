# General Agent

Eigenständiges Projekt. **Nicht** Teil von Behördenpost / `personal-agent`.

## Produkt

Interner KI-Baukasten (**Universal Knowledge Analyzer**): Quellen importieren, segmentieren, mit OpenAI aufbereiten, in Supabase speichern, hybrid suchen, per Profil chatten oder batch-analysieren.

## Stack

- Next.js (App Router) + TypeScript + React + Tailwind
- Supabase (Postgres, Storage, Auth) + pgvector
- OpenAI über abstrahierte `AIProvider`-Schicht
- Zod für Validierung

## Repo

| | |
|---|---|
| Lokaler Ordner | `general-agent` |
| GitHub | https://github.com/danielsoboll/Universal-agent.git |
| Branch | `main` — Push nur auf explizite Anfrage |

## Supabase

| | |
|---|---|
| Project URL | `https://pkcucpsrwgactejovdmp.supabase.co` |
| Project ref | `pkcucpsrwgactejovdmp` |
| Link | `supabase link --project-ref pkcucpsrwgactejovdmp` |

Env: `.env.local` (lokal, nicht committen). Vorlage: `.env.example`.

## Lokale SAP-Daten (`LOCAL_DATA_ROOT`)

- Pfad **nur** aus `.env.local` lesen — nie im Code hart codieren
- Kundendaten / Rohdaten **nie** ins Git-Repo kopieren
- Zugriff nur über `src/lib/localData` (Root-Validierung, kein Escape)
- `raw/` read-only; Writes nur: `canonical`, `analyses`, `embeddings`, `indexes`, `logs`
- Check: `npm run local-data:check`
- Kundenprofile: `customers/<customer_id>.json` (Vorlage `_template.json`)
- Orchestrierung: `npm run pipeline -- --customer P01 --list-steps`
- Architektur: `docs/PRODUCTIZATION.md`, Migration P01: `docs/P01_MIGRATION.md`

## Konventionen

- UI: Deutsch
- Secrets nie committen (`.env.local`, DB-Passwort, Secret Key, OpenAI)
- OpenAI-Keys und `SUPABASE_SECRET_KEY` nur serverseitig
- Originalinhalte nie durch KI-Ausgaben überschreiben
- Kein Bezug zu `personal-agent`, LifeXP oder post.life-xp.de
