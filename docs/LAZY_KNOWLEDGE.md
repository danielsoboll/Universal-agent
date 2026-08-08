# Lazy Knowledge — NO KNOWLEDGE LOADING ON RENDER

Stand: **abgeschlossen** (Checkpoint `lazy-knowledge-stable`, 2026-08-08).

Regression: `npm run e2e:lazy-knowledge-checkpoint`  
Ergebnis: `tmp/regression/lazy-knowledge-checkpoint.json`

## Regel (verbindlich)

**NO KNOWLEDGE LOADING ON RENDER.**

Knowledge Access ist:

1. **serverseitig**
2. **request-driven** — erst bei konkreter Ask-/Analyse-Anfrage
3. **nie** beim Page Render / RSC / Navigation

Der Browser/UI erhält niemals den kompletten Wissensbestand.

## Erlaubt beim Rendern

- Auth / User
- `customerId` / `projectId`
- Projektname, Freigabestatus, Rollen
- kleine persistierte Status-Metadaten (z. B. `logs/setup_status_snapshot.json`)

## Verboten beim Rendern

- Canonical scannen
- Exportverzeichnisse prüfen
- Knowledge Graph laden
- SearchDocs / Access Indices lesen
- Embeddings prüfen
- Control-Table-Content lesen
- Disk-Reconcile (`reconcileControlTablesFahrplanFromDisk`, `verifyExistingKnowledge`, …)

Schwere technische Prüfung nur:

- explizite Admin-Aktion („Status aktualisieren“ / „Datenbestand prüfen“)
- oder dedizierter Admin-API-/Server-Action-Endpunkt

## Schichten

```
UI (RSC / Client)
  → API Route / Server Action   ← einzige Knowledge-Einstiege für Ask
    → Knowledge Store Interface   ← src/lib/knowledgeStore
      → Adapter (heute: LOCAL_DATA_ROOT / portable indices)
      → Adapter (später: Azure / Supabase / Postgres)
```

### UI-Grenze

Keine UI-Komponente darf `LOCAL_DATA_ROOT` kennen oder `src/lib/localData` / Index-Loader direkt importieren.

### Ask

- Page `/app/ask` und `AskQuestionPanel`: keine statischen Imports von Knowledge-/Retriever-Modulen oder `askQuestionAction`.
- Fachlicher Ask-Lauf nur über `POST /api/app/ask` (dynamischer Server-Pfad innerhalb des Requests).

### Übersicht `/app`

- `buildAppOverviewLightweight` — Snapshot oder DB-Metadaten, kein Disk-Reconcile.

### Admin `/admin/dashboard`

- Render: `loadCachedDashboardOverview` (Snapshot).
- Refresh: `refreshSetupStatusAction` → `refreshDashboardOverview` (Reconcile + Snapshot schreiben).

## Checkpoint-Kennzahlen (P01, 2026-08-08)

Gemessen parallel zu Background-Enrichment (Night-Run 500).

| Pfad | Render | Files | Bytes | Knowledge Loader | Disk Reconcile |
|------|-------:|------:|------:|------------------|----------------|
| **Vorher** Overview-Render | ~5857 ms | 123 | ~1,21 GB | ja | ja |
| A Login→`/app` | 1,6 ms | 1 | 5,4 KB | nein | nein |
| B `/app`→Fragen | ~0 ms | 0 | 0 | nein | nein |
| C Fragen→Quellen | ~0 ms | 0 | 0 | nein | nein |
| D Quellen→Verlauf | ~0 ms | 0 | 0 | nein | nein |
| E Verlauf→`/app` | 0,4 ms | 1 | 5,4 KB | nein | nein |
| F →`/admin/dashboard` | 0,4 ms | 1 | 5,4 KB | nein | nein |
| Admin „Datenbestand prüfen“ | ~6878 ms | 123 | ~1,21 GB | ja | ja (gewollt) |

Ask-Smoke (Direkte Suche): Edeka virtuelles Lager `ok`; ZECD `ok`; ZZ_VLAGER-Verwendung `ok`; OCTOPUS `insufficient` (kein Treffer im Index — kein Pipeline-Fehler).

## Bewusst unverändert

- Ask-Retrieval, Search Budget, Modi, Evidence/Claims
- Background Enrichment (Runner, Cache, Formate, Outputs)
- Bestehende Indices / Canonical

## Bekannte Lücken (nicht Teil dieses Umbaus)

- `/admin/steps/[stepId]` kann weiterhin live reconcilen (Setup-Arbeitsseite).
- Ask-Laufzeiten selbst (OpenAI/Index) sind unabhängig von Navigation-Lazy.
- Keine Azure-/Supabase-Knowledge-Migration in diesem Checkpoint.
