/**
 * Regression: generische lexikalische DDIC-Suche.
 * Erwartete Treffer für „Edeka virtuelles Lager“ — ohne Produktions-Sonderlogik.
 *
 *   npx tsx tests/search/lexicalDdicSearch.test.ts
 */
import assert from "assert";
import {
  normalizeLexicalQuery,
  runLexicalSearch,
  scoreLexicalDocument,
  type LexicalDocument,
} from "../../src/lib/search/lexical";

const QUESTION = "Wie funktioniert das Edeka virtuelle Lager?";

// --- Query-Normalisierung ---
const norm = normalizeLexicalQuery(QUESTION);
assert.ok(
  norm.stopwords_removed.includes("wie") ||
    norm.stopwords_removed.includes("funktioniert") ||
    norm.stopwords_removed.includes("das"),
  "Stopwörter entfernt",
);
assert.ok(
  norm.content_terms.some((t) => t.includes("edeka")),
  `content_terms edeka: ${norm.content_terms.join(",")}`,
);
assert.ok(
  norm.content_terms.some((t) => t.startsWith("virtuell")),
  `content_terms virtuell*: ${norm.content_terms.join(",")}`,
);
assert.ok(
  norm.content_terms.some((t) => t.includes("lager")),
  `content_terms lager: ${norm.content_terms.join(",")}`,
);
assert.ok(
  norm.phrases.some((p) => p.includes("virtuell") && p.includes("lager")),
  `phrases: ${norm.phrases.join(" | ")}`,
);
assert.ok(
  !norm.content_terms.includes("wie") &&
    !norm.content_terms.includes("funktioniert"),
  "Fragewörter nicht als Konzepte",
);

// --- Fixture-Korpus (generisch, keine Hardcodes in der Suchlogik) ---
const docs: LexicalDocument[] = [
  {
    id: "f1",
    kind: "ddic_field",
    technical_name: "KNVV-ZZ_VLAGER",
    title: "KNVV-ZZ_VLAGER",
    table_name: "KNVV",
    field_name: "ZZ_VLAGER",
    field_text: "Kennzeichen virtuelles Lager",
    data_element: "ZZ_SD_VLAGER",
    data_element_text: "",
    domain: "XFELD",
    domain_text: "",
    append_include: true,
    source_path: "canonical/master-data/customers/KNVV/structure.jsonl",
    search_text:
      "KNVV-ZZ_VLAGER · Kennzeichen virtuelles Lager · ZZ_SD_VLAGER · XFELD",
  },
  {
    id: "f2",
    kind: "ddic_field",
    technical_name: "MARD-LGORT",
    title: "MARD-LGORT",
    table_name: "MARD",
    field_name: "LGORT",
    field_text: "Lagerort",
    source_path: "canonical/master-data/materials/MARD/structure.jsonl",
    search_text: "MARD-LGORT · Lagerort",
  },
  {
    id: "t1",
    kind: "control_table",
    technical_name: "ZSD_VLAGER_CFG",
    title: "ZSD_VLAGER_CFG",
    table_name: "ZSD_VLAGER_CFG",
    table_text: "Steuerung virtuelles Lager je Verkaufsorganisation",
    field_text: "Steuerung virtuelles Lager je Verkaufsorganisation",
    source_path: "canonical/control-tables/table_definitions.jsonl",
    search_text:
      "ZSD_VLAGER_CFG · Steuerung virtuelles Lager je Verkaufsorganisation",
  },
  {
    id: "c1",
    kind: "method",
    technical_name: "ZCL_STOCK|METHOD|GET_LGORT",
    title: "ZCL_STOCK|METHOD|GET_LGORT",
    code_summary: "Liest generischen Lagerort aus MARD",
    source_path: "canonical/classes/code_units.jsonl",
    search_text: "ZCL_STOCK GET_LGORT Liest generischen Lagerort aus MARD",
  },
  {
    id: "f3",
    kind: "ddic_field",
    technical_name: "KNA1-NAME1",
    title: "KNA1-NAME1",
    table_name: "KNA1",
    field_name: "NAME1",
    field_text: "Name 1",
    source_path: "canonical/master-data/customers/KNA1/structure.jsonl",
    search_text: "KNA1-NAME1 · Name 1",
  },
];

const result = runLexicalSearch({
  question: QUESTION,
  documents: docs,
  limit: 10,
});

assert.ok(result.diagnosis.phrase_hits >= 2, "Phrase trifft mehrere Docs");
const phraseDocs = result.hits.filter((h) =>
  h.channels.includes("exact_phrase"),
);
assert.ok(
  phraseDocs.length >= 2,
  `Phrase-Hits: ${phraseDocs.map((h) => h.doc.technical_name).join(",")}`,
);

const zz = result.hits.find((h) => h.doc.technical_name === "KNVV-ZZ_VLAGER");
assert.ok(zz, "ZZ_VLAGER gefunden");
assert.ok(zz!.primary_anchor_candidate, "ZZ_VLAGER Primäranker-Kandidat");
assert.ok(
  zz!.channels.includes("exact_phrase"),
  "exakte Phrase in field_text",
);

const lgort = result.hits.find((h) => h.doc.technical_name === "MARD-LGORT");
assert.ok(zz!.score > (lgort?.score ?? 0), "Fachfeldtext > generisches LGORT");

const ct = result.hits.find((h) => h.doc.kind === "control_table");
assert.ok(ct, "Z-/Y-Steuertabelle mit Beschreibung gefunden");
assert.ok(
  ct!.channels.includes("exact_phrase") || ct!.score >= 90,
  "Steuertabelle stark bewertet",
);

assert.strictEqual(
  result.diagnosis.selected_primary_anchors[0]?.technical_name,
  "KNVV-ZZ_VLAGER",
);

// Ranking: field_text phrase schlägt Code-Summary
const code = scoreLexicalDocument(docs[3]!, norm);
assert.ok(zz!.score > code.score, "DDIC field_text vor Code-Summary");

// Diagnose vollständig
assert.ok(result.diagnosis.query.phrases.length > 0);
assert.ok(result.diagnosis.top_hits.length > 0);
assert.ok(Array.isArray(result.diagnosis.rejected));

console.log("lexicalDdicSearch.test.ts OK");
console.log(
  JSON.stringify(
    {
      phrases: norm.phrases.slice(0, 5),
      content_terms: norm.content_terms,
      top: result.hits.slice(0, 4).map((h) => ({
        name: h.doc.technical_name,
        score: h.score,
        channels: h.channels,
      })),
      primary: result.diagnosis.selected_primary_anchors,
    },
    null,
    2,
  ),
);
