# Access Indices — Architektur & Ist-Lage

Stand: Access-Index-Build für P01 (kein Canonical-/Graph-/Embedding-Rebuild).

## Pipeline-Schichten (verbindlich)

```
RAW
  → SOURCE NORMALIZATION
  → CANONICAL KNOWLEDGE
  → CROSS-SOURCE LINKING / KNOWLEDGE GRAPH
  → ACCESS INDICES          ← nur diese Schicht baut `indexes/*` portable
  → EMBEDDINGS (optional, lazy)
  → ASK
```

### Was Access Indices dürfen

- vorhandene Canonical-/Search-/KG-/Code-Artefakte **schnell zugreifbar** machen
- Exact-Lookups (Symbol, Literal, Feldnutzung) und Lexical/Graph-Beschleunigung
- immer **Evidence-Rückverweis** (`source_key`, relative path, Zeile/Hash)

### Was Access Indices nicht dürfen

- Canonical oder Raw ersetzen
- Informationen wegwerfen, die später nicht mehr auffindbar sind
- neue fachliche Wahrheit erzeugen
- heutige Canonical-Dateipfade als endgültiges Fachmodell festschreiben
- OpenAI-Massenläufe oder neue Embeddings erzwingen

## Adaptergrenze

```
Canonical / normalized source
        ↓  (source-spezifischer Adapter)
KnowledgeRecord / IndexRecord   ← src/lib/portableIndex/knowledgeRecord.ts
        ↓
Access Index Builder            ← src/lib/portableIndex/buildPortableIndex.ts
        ↓
indexes/{symbol,literal,lexical,graph,evidence,vector}-index
```

Adapter-Registry (Ist): `src/lib/portableIndex/adapters/canonicalAdapters.ts`

Später können Source-Pipelines verbessert werden, ohne Ask oder alle Index-Formate neu zu erfinden — solange sie auf `KnowledgeRecord` mappen.

## Access-Index-Arten (P01)

| Index | Pfad | Zweck |
|---|---|---|
| Symbol | `indexes/symbol-index/` | Objekte / Namen → document_id / source_key |
| Literal | `indexes/literal-index/` | Exact Strings/Nummern im Code + Feldkontext |
| Lexical | `indexes/lexical-index/` | Kompakte Suchtexte / Tokens |
| Graph | `indexes/graph-index/` | Nodes/Edges/Adjacency (Zugriffsbeschleunigung) |
| Evidence | `indexes/evidence-store/` | Beleg-Metadaten + Verweis, kein Ersatz für Raw |
| Vector | `indexes/vector-index/` | Dünne Refs; Embeddings bleiben unter `embeddings/` |

Manifest: `indexes/portable-manifest.json` (Fingerprint, Quellen-Stamps, Counts).

Build: `npm run index:portable -- --customer P01`  
Kein OpenAI. Unveränderte Quellen → Skip (Fingerprint).

## Exact vs. Semantic

| Frage-Typ | Mechanismus |
|---|---|
| „Wo steht 4711 hart codiert?“ | Literal Index (exact) |
| „Wer verwendet ZZ_VLAGER?“ | Symbol / Field Usage + Graph |
| „Was hängt an ZECD?“ | Symbol + Graph |
| „Welche Programme greifen auf MARA zu?“ | Technical usage / Symbol |
| „Wo wird entschieden aus welchem Lager…?“ | Lexical / später Vector → Seeds → Graph → Evidence |

Embeddings **nicht** blind neu erzeugen. Sinnvolle Kandidaten später: Method Analyses, Summaries, Prozesstexte — nicht MATNR/VKORG/IDs.

## Evidence-Regel

Jeder Index-Eintrag darf verkürzen, muss aber zum Originalbeleg führen:

`literal/symbol/… → source_key (+ line/span) → Evidence Store / Canonical / Raw`

Ask darf verdichtete Index-Infos nicht als alleinige Wahrheit ausgeben, wenn der Beleg verfügbar sein sollte.

## Inkrementell (Vorbereitung)

Manifest speichert je Quelle: `relative_path`, `mtime_ms`, `size`, `content_hash`.  
Später: nur betroffene Adapter → betroffene KnowledgeRecords → betroffene Index-Slices — kein Full Rebuild bei jeder Datei.

---

## Source-Übersicht (Ist → Zukunft)

| SOURCE | Heutiger RAW-Input | Heutige Canonical-Ausgabe | Qualität / Informationsverlust | Benötigte zukünftige Normalisierung | KnowledgeRecord-Typen | Index-Typen |
|---|---|---|---|---|---|---|
| Material-/Stammdaten | `raw/` SAP Material/Customer/Vendor Exports | `canonical/master-data/{customers,materials,vendors}/*/structure.jsonl` (+ Related) | Strukturfelder gut; Business-Bedeutung / Werks-VKOrg-Graph oft dünn; Texte ungleichmäßig | Material-/Werk-/VKOrg-Objekte + Attribute + Beziehungen als eigene Records; keine „flachen“ Structure-only-Pfade | MASTER_DATA, ATTRIBUTE, RELATION, TEXT | lexical, symbol, field_usage, evidence |
| Z-/Control-Tables | Raw Customizing / Tabellenexporte | `canonical/control-tables/{table_definitions,entities,classifications,relations,rows}.jsonl` | Definitionen/Entities stark; Rows groß; fachliche Schlüssel oft nicht als first-class Entities | Config-Objekte + Schlüsselwerte + Relationen; Rows nur evidence-verlinkt | CONFIG, ATTRIBUTE, RELATION, EVIDENCE | symbol, lexical, field_usage, evidence |
| Message / IDoc Config | Raw NAST/TNAPR/Partner/Port/… | `canonical/message-idoc-config/objects.jsonl` (+ Pipeline 11 Relations) | Objekte vorhanden; Kommunikationspfade teils nur über KG/Relations erschlossen | Output Type, Partner, Port, Logical System, Message/IDoc als Entities + PATH-Relationen | CONFIG, OBJECT, RELATION | symbol, graph, lexical, evidence |
| Repository Objects | Raw Repo-Objektlisten | Canonical Objects / Zones unter classes/programs/FM | Objektkatalog ok; Metadaten ungleich | Stabile OBJECT-Records mit system_id, object_type, object_name | OBJECT | symbol, graph |
| Repository Relations | Raw where-used / includes / calls | Relations + KG-Eingang | Gut für technische Kanten; semantische Kanten (z. B. CODE_REFERENCES_MATERIAL) fehlen oft | Explizite RELATION-Records + Cross-Source-Link-Stufe | RELATION, CODE_REFERENCE | graph, symbol, field_usage |
| ABAP Code Units | Raw Sources in Repo | `canonical/{classes,programs,function-modules}/code_units.jsonl` (inkl. `source_code`) | Vollständiger Code im Canonical — teuer zu scannen; Access-Index extrahiert Literale/Usage | CODE_UNIT ohne Volltext-Duplikat im Index; Literale/Calls als eigene Records; Source bleibt Canonical/Raw | CODE_UNIT, LITERAL, CODE_REFERENCE | literal, symbol, field_usage, evidence |
| Method / Unit Analyses | — (OpenAI/Analyse-Pipeline) | `analyses/…` + Felder in SearchDocuments | Hoher Semantik-Wert; Abdeckung unvollständig; teuer | ANALYSIS-Records; selektiv embedden | ANALYSIS, TEXT, EVIDENCE | lexical, vector (später), evidence |
| Knowledge Graph | abgeleitet aus Message/Repo/… | `canonical/knowledge-graph/{nodes,edges,unresolved}.jsonl` | Große Node/Edge-Mengen; Kontexte teils aufgebläht; Cross-Source-Business-Links lückenhaft | Persistente Graph-Schicht erweitern (nicht nur Access-Kopie); unresolved pflegen | OBJECT, RELATION | graph, symbol |
| Hybrid Search Documents | abgeleitet aus Analyses/Units | `indexes/search/search_documents.jsonl` + Exact/Fulltext/… | Guter Ask-Baseline; mischt Evidence+Search; ~70MB+ | Evidence Store schlank halten; Search-Shards aus KnowledgeRecords erzeugen | EVIDENCE, TEXT, OBJECT | evidence, symbol, lexical (+ legacy search shards) |
| Embeddings | aus SearchDocuments | `embeddings/search/search_embeddings.jsonl` | Vorhanden; für Exact-Fragen ungeeignet; teuer | Nur ANALYSIS/TEXT/Summaries; Exact-IDs nie rein über Vector | — (Vektoren zu Records) | vector (lazy) |

---

## Access Indices im Ask-Pfad

Wenn `indexes/portable-manifest.json` vorhanden ist, nutzt Ask die Access Indices als **primäre Zugriffsschicht**:

| Frage-Typ | Primary Path | Embeddings |
|---|---|---|
| Literal / Hardcoding | `literal-index` | nie bei Miss |
| Exact / Symbol / Relation | `symbol` + optional `graph` + targeted `evidence` | nein |
| Semantik (ohne starken Exact-Treffer) | lexical → ggf. Vector lazy | nur wenn Stage-1 es verlangt |

Legacy `indexes/search/{fulltext,exact,metadata,vector}_index.*` werden **nicht** geladen, außer:

- Access Indices fehlen/beschädigt, oder
- `ASK_FORCE_LEGACY_SEARCH=1` (Debug)

Targeted Evidence: `evidence-store/id_offsets.jsonl` (einmalig aus `documents.jsonl` erzeugt).


