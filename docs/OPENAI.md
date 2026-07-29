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

Lokal darf `OPENAI_API_KEY` fehlen: Build und App bleiben stabil; OpenAI-Aufrufe
liefern dann klar `OPENAI_API_KEY nicht konfiguriert` / `fehlerkategorie: not_configured`.

Der eigentliche Verbindungstest erfolgt auf **Vercel Production** (dort den Key setzen):

```bash
npm run openai:health:production
```

Optional: `PRODUCTION_APP_URL`, `VERCEL_AUTOMATION_BYPASS_SECRET` (bei Deployment Protection).

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
npm run openai:health
```

Oder in der App (nur aktive Projekt-Owner): Startseite → „Verbindung testen“.
Oder `POST /api/internal/openai-health` mit gültiger Owner-Session.

Ergebnis enthält nur:

```json
{
  "erreichbar": "ja",
  "modell": "gpt-4.1-mini",
  "laufzeit_ms": 123,
  "fehlerkategorie": null
}
```

Kein API-Key, keine Prompt-Inhalte, keine vollständige Provider-Antwort.
