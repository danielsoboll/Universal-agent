# Generic Seed Enrichment (Ask)

Nach einem **bestätigten technischen Seed** (oder FIELD-ähnlichem Lexical-/Hit-Seed)
lädt Ask deterministisch verbundene Knowledge-Typen nach — ohne Objekt-Hardcoding.

## Ablauf

```
Retrieval (Access Indices)
  → confirmed / field-like seeds (z. B. KNVV-ZZ_VLAGER)
  → enrichConfirmedFieldSeeds()
       FIELD → DDIC entity
             → observed attribute values / master instances
             → code usage links
             → graph config neighbors (nur vorhandene Kanten)
  → synthetic enrichment hits + Prompt-Block
  → LLM-Synthese
  → applySeedEnrichmentToAnswer()  (Counts/Beispiele erzwingen)
```

## Presentation Hints (nur Darstellung)

| Hint | Trigger (Beispiele) | Priorität |
|---|---|---|
| `how_works` | „Wie funktioniert…“ | Mechanismus + Instanzen + Code |
| `where_used` | „Wo wird… verwendet?“ | Code/Config |
| `which_instances` | „Welche Kunden haben…?“ | Master-Data-Instanzen |

Retrieval-Basis bleibt gleich.

## Module

- `src/lib/knowledge/seedEnrichment/`
- verdrahtet in `accessIndexSearch.ts` + `answerQuestion.ts`

## Regression / Test

```bash
npx tsx scripts/e2e-ask-vlager-enrichment.ts
```

Erwartung u. a.: Count der Sales Areas mit Feldwert, Kundennamen-Beispiele,
Code-Usage inkl. `ZCL_VIRTUELLES_LAGER` — **ohne** fest verdrahtete V-Lager-Antwort.
