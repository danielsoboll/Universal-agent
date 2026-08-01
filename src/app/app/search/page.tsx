import { loadUiGuideTexts } from "@/lib/onboarding/uiGuideTexts";
import { SectionTitleWithInfo } from "@/components/ui/SectionTitleWithInfo";

export default async function AppSearchPage() {
  const guides = await loadUiGuideTexts(["app.search"]);

  return (
    <div className="space-y-4">
      <SectionTitleWithInfo
        as="h1"
        title="Suche"
        subtitle="Platzhalter: Hybrid Search und belegbare Antworten folgen."
        guide={guides.get("app.search")}
      />
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
      </div>
    </div>
  );
}
