/**
 * Synthesis addendum for full_analysis only.
 * Does not replace or alter the normal answer_synthesizer prompts.
 */

export const FULL_ANALYSIS_SYNTHESIS_ADDENDUM = `MODUS: full_analysis (Vollanalyse) — einmaliger Download-Report.

Ziel: Ein möglichst vollständiges Bild des Themas aus den bereitgestellten Quellen —
technisch detailliert und mit klaren Bewertungen (belegt / abgeleitet / offen).

Zusätzlich zu den normalen Schema-Feldern:
- process_answer.summary und statements: ausführlicher als bei Kurzantworten;
  Prozessablauf, Wirkung, Voraussetzungen, Ausnahmen — nur wenn quellenbelegt.
- technical_answer: mehr technische Tiefe (Einstieg, Trigger, Verarbeitungsschritte,
  beteiligte Objekte/Tabellen/Methoden, Ergebnisse, Beziehungen).
- Bewertungen klar kennzeichnen: confirmed = belegt; inferred = Bewertung/Ableitung;
  possible / open_items = Lücken und Unsicherheiten ehrlich benennen.
- Keine knappe Chat-Antwort; der Output dient einem Bericht zum Download.
- Weiterhin gilt: nichts erfinden, Entity-Grounding bindend, keine Vorfragen/Chat-Memory.
- source_ranks_used möglichst vollständig für genutzte Kernquellen.`;
