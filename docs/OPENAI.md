# OpenAI-Anbindung (serverseitig)

## Zweck

Minimale, austauschbare Provider-Schicht für spätere Analyse/Embeddings.
Kein Chat-RAG, keine Produkt-Prompts, keine automatische Dateiübertragung.

## Umgebungsvariable

| Variable | Scope | Hinweis |
|---|---|---|
| `OPENAI_API_KEY` | **nur Server** | Niemals `NEXT_PUBLIC_`, niemals Client-Bundle, niemals committen |

### Vercel

In Project → Settings → Environment Variables für **alle drei** setzen:

1. Production
2. Preview
3. Development

Wert nur im Dashboard / Secret Store — nicht in Git.

Lokal: Eintrag in `.env.local` (siehe `.env.example`).

## Code

| Pfad | Rolle |
|---|---|
| `src/lib/ai/types.ts` | `AIProvider`-Schnittstelle |
| `src/lib/ai/openaiProvider.ts` | OpenAI-Implementierung |
| `src/lib/ai/provider.ts` | Factory (`getAIProvider`) — `server-only` |
| `src/lib/ai/config.ts` | Modelle zentral (`gpt-4.1-mini`, `text-embedding-3-small` / 1536) |
| `src/lib/ai/usageLog.ts` | optionales Schreiben in `ai_usage_logs` (service role) |
| `src/actions/aiHealth.ts` | Owner-only Verbindungstest |
| `scripts/openai-health.ts` | CLI-Health-Check |

## Verbindungstest

```bash
npx tsx scripts/openai-health.ts
```

Oder in der App (nur aktive Projekt-Owner): Startseite → „Verbindung testen“.

Ergebnis enthält nur: erreichbar / nicht erreichbar, Modell, Laufzeit, Fehlerkategorie.
Kein API-Key, keine vollständige Provider-Antwort.
