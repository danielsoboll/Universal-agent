# Produktisierbarkeit — Architekturvorschlag

Stand: lokale Pipeline (Canonical → Analyse → Index → Control-Tables).  
**Keine Änderung der Fachlogik, keine erneute OpenAI-Analyse, keine Änderung bestehender `source_key`/`content_hash`.**

## Ist-Zustand (Probleme)

| Thema | Heute | Risiko |
|---|---|---|
| Projektpfad | `PROJECT_KEY = "P01"` in vielen Scripts | Neuer Kunde = Copy/Paste |
| Prompt-Versionen | Konstanten in Analyse-Modulen | Schwer nachvollziehbar je Lauf |
| Schritte | lose npm-Scripts | Keine einheitliche Orchestrierung |
| Lauf-Metadaten | verstreute Log-Reports | Kein Manifest „was lief mit welcher Version“ |
| Adapter vs. Core | SAP-Code neben generischem Search | Vermischung |
| Tests | kaum Fixture/Golden für Pipeline | Regressionen teuer |

## Zielbild

```
customers/<customer_id>.json     ← nur Konfiguration
src/lib/core/                    ← generisch (Config, Registry, Manifest, CLI)
src/lib/adapters/sap/            ← SAP-spezifisch (bestehende Logik bleibt, wird referenziert)
LOCAL_DATA_ROOT/<customer_id>/   ← unveränderte Datenlayout-Zone (P01 bleibt)
```

Neuer Kunde:

1. `customers/<id>.yaml|json` anlegen (Profile)
2. `LOCAL_DATA_ROOT/<id>/{raw,canonical,...}` anlegen (oder Mapping auf bestehendes Layout)
3. `npm run pipeline -- --customer <id> --system <sys> --step <name>`

Kein Umschreiben von Analyse-/Ingest-Code nötig.

## Schichten

### 1. Core (`src/lib/core/`)

- `customerConfig.ts` — Zod-Schema, Laden/Validieren
- `promptRegistry.ts` — explizite Prompt-IDs + Versionen (nur Metadaten; Texte bleiben wo sie sind)
- `pipelineRegistry.ts` — Steps mit id, Adapter, I/O-Zonen, Idempotenz-Hinweis
- `runManifest.ts` — Manifest je Lauf schreiben/lesen
- `cli.ts` / `scripts/pipeline.ts` — generische CLI

**Core enthält keine** Tabellen-, Kunden-, Klassen- oder Produktnamen.

### 2. SAP-Adapter (bestehend, nur verdrahten)

Bleibt funktional unter `src/lib/ingest/*`, `src/lib/analysis/*`, `src/lib/search/adapters/*`.  
Pipeline-Steps rufen bestehende Entry-Points auf bzw. dokumentieren die bestehenden Scripts als Step-Handler.

Spätere physische Verschiebung nach `adapters/sap/` ist optional und **nicht** Teil dieses Schritts (vermeidet Diff-Risiko).

### 3. Kundenspezifische Konfiguration

Nur unter `customers/`:

```json
{
  "customer_id": "P01",
  "display_name": "…",
  "systems": [{ "system_id": "D01", "label": "…" }],
  "data_root_project_key": "P01",
  "enabled_source_types": ["sap_class", "sap_control_table"],
  "pipeline_defaults": { "prompt_versions": { "unit_analysis": "unit-analysis-v4" } },
  "paths": { "raw_classes": "raw/classes", … }
}
```

`data_root_project_key` = Ordner unter `LOCAL_DATA_ROOT` (für P01: `"P01"` → bestehende Dateien weiter nutzbar).

## Pipeline-Steps (Registry)

| Step-ID | Script / Handler | Zone I/O | OpenAI |
|---|---|---|---|
| `canonicalize.sap_classes` | existing | raw→canonical | nein |
| `analyze.sap_code_units` | existing | canonical→analyses | ja |
| `index.search_documents` | existing | analyses→indexes | nein |
| `canonicalize.control_tables` | existing | raw→canonical | nein |
| `link.code_control_tables` | existing | canonical→canonical | nein |
| `analyze.control_tables` | geplant | canonical→analyses | ja (nicht anfassen) |
| `interpret.code_table` | geplant | →analyses | ja (nicht anfassen) |

Jeder Step bekommt: `id`, `title`, `requires`, `produces`, `prompt_ids[]`, `idempotent`, `handler`.

## Prompt-Registry

Explizite Einträge, z. B.:

- `unit-analysis` @ `unit-analysis-v4` → Modul `unitAnalysisPrompt`
- `control-table-analysis` @ `control-table-analysis-v1` (reserviert, nicht ausführen)
- `code-table-interpretation` @ `code-table-interpretation-v1` (reserviert)

Registry speichert **Version + Modulpfad + Schema-Name**, nicht den Prompt-Text doppelt.  
Bestehende Analysen behalten ihre `prompt_version` in den JSONL-Dateien.

## Pipeline-Manifest

Pro Lauf unter:

`LOCAL_DATA_ROOT/<project>/logs/runs/<run_id>/manifest.json`

Inhalt (Mindestens):

- `run_id`, `customer_id`, `system_id`, `started_at`, `finished_at`
- `steps[]`: id, status, prompt_versions, input/output paths, counts
- `git_commit` (optional), `cli_args`
- **kein** erneutes Analysieren nur wegen Manifest-Schreiben

## CLI

```bash
npm run pipeline -- --customer P01 --system D01 --step canonicalize.control_tables
npm run pipeline -- --customer P01 --system D01 --list-steps
npm run pipeline -- --customer P01 --init-layout   # nur Ordner anlegen, keine Analyse
```

Wrapper setzt `projectKey` aus CustomerConfig und delegiert an bestehende Scripts (via `spawn` oder importierte `main`-Funktionen wo vorhanden).

## Fixture- / Golden-Tests

```
tests/fixtures/customers/demo/
  customer.json
  raw/... (minimale anonymisierte Snippets)
tests/golden/
  canonicalize.control_tables.manifest.json
  search_document.sample.json
```

Tests prüfen: Config-Validierung, Manifest-Schema, stabile `source_key`-Serialisierung an **synthetischen** Fixtures — nicht P01-Produktivdaten.

## Migrationsstrategie P01

1. **Keine Datenverschiebung.** `customers/P01.json` mit `data_root_project_key: "P01"`.
2. Bestehende JSONL unverändert lassen (`source_key`, Hashes, Analysen).
3. Neue Läufe schreiben zusätzlich Manifests unter `logs/runs/`.
4. Alte npm-Scripts (`canonicalize:sap-classes` etc.) bleiben als Aliase funktionsfähig.
5. OpenAI-Pilot: Steps `analyze.*` nur ausführen wenn explizit `--step` gesetzt — Default-Orchestrierung startet sie **nicht** neu.

## Nicht-Ziele dieses Umbaus

- Keine Prompt-/Parser-Änderungen
- Keine Re-Analyse, kein Embedding, kein Supabase
- Keine Umbenennung bestehender output paths
- Keine DGL-/Optitool-/Tabellen-Hardcodes im Core

## Betroffene / neue Dateien

### Neu

- `docs/PRODUCTIZATION.md` (dieser Vorschlag)
- `customers/P01.json`
- `customers/_template.json`
- `src/lib/core/customerConfig.ts`
- `src/lib/core/promptRegistry.ts`
- `src/lib/core/pipelineRegistry.ts`
- `src/lib/core/runManifest.ts`
- `src/lib/core/loadEnv.ts`
- `scripts/pipeline.ts`
- `tests/fixtures/customers/demo/customer.json`
- `tests/golden/README.md`
- `tests/core/customerConfig.test.ts` (leichtgewichtig via tsx)

### Anpassen (minimal)

- `package.json` — Script `pipeline`
- `AGENTS.md` — kurzer Verweis auf CustomerConfig / pipeline CLI

### Unberührt (Fachlogik)

- `src/lib/analysis/*`, `src/lib/ingest/*`, `src/lib/search/*` (außer ggf. späterer Import aus CLI)
- alle bestehenden Analyse-JSONL unter `P01/`
- geplante/laufende OpenAI-Pilotanalyse
