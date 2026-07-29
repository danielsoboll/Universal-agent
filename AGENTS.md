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

## Konventionen

- UI: Deutsch
- Secrets nie committen (`.env.local`, DB-Passwort, Secret Key, OpenAI)
- OpenAI-Keys und `SUPABASE_SECRET_KEY` nur serverseitig
- Originalinhalte nie durch KI-Ausgaben überschreiben
- Kein Bezug zu `personal-agent`, LifeXP oder post.life-xp.de
