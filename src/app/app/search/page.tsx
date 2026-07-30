import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { ActionGuide } from "@/components/onboarding/ActionGuide";

export default async function AppSearchPage() {
  const guides = await loadUiGuideTexts(["app.search"]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Suche</h1>
      <p className="muted">
        Platzhalter: Hybrid Search und belegbare Antworten folgen. Keine Admin-Steuerung
        in diesem Bereich.
      </p>
      <div className="panel space-y-3 p-6">
        <label className="label" htmlFor="q">
          Frage
        </label>
        <input
          id="q"
          className="input"
          disabled
          placeholder="Suche wird nach Freigabe aktiviert"
        />
        <ActionGuide guide={guides.get("app.search")} />
      </div>
    </div>
  );
}
