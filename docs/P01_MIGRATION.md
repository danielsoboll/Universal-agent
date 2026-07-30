# P01-Migration (ohne Datenbewegung)

## Prinzip

Bestehende Dateien unter `LOCAL_DATA_ROOT/P01/` bleiben die Single Source of Truth.
Es gibt **keine** Umschlüsselung von `source_key` / `content_hash` / Analyse-JSONL.

## Schritte

1. Kundenprofil anlegen: `customers/P01.json`  
   - `customer_id`: `P01`  
   - `data_root_project_key`: `P01` (gleicher Ordner)
2. Optional Layout-Check:  
   `npm run pipeline -- --customer P01 --init-layout`  
   (legt fehlende Unterordner an, überschreibt keine Raw-/Analyse-Dateien)
3. Deterministische Steps weiter wie bisher oder via CLI:  
   `npm run pipeline -- --customer P01 --system D01 --step canonicalize.control_tables`
4. OpenAI-Steps (`analyze.*`, `interpret.*`) **nicht** auto-starten; nur explizit und nur wenn gewollt.
5. Alte npm-Scripts (`canonicalize:sap-classes`, …) bleiben gültig.

## Was sich ändert

| Vorher | Nachher |
|---|---|
| Hardcoded `P01` nur in Scripts | Zusätzlich CustomerConfig + Pipeline-CLI |
| Keine Run-Manifests | `logs/runs/<run_id>/manifest.json` bei CLI-Läufen |
| Prompt-Versionen verstreut | Prompt-Registry + Pin in CustomerConfig |

## Was sich nicht ändert

- Rohdaten, Canonical, bestehende Analysen, Indexes
- Hash- und Key-Algorithmen
- Laufende/geplante OpenAI-Pilotanalyse
