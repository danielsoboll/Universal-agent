import "server-only";
import { createClient } from "@/lib/supabase/server";

export type UiGuideText = {
  guide_key: string;
  title: string;
  body: string;
  surface: string;
};

export async function loadUiGuideTexts(
  keys?: string[],
): Promise<Map<string, UiGuideText>> {
  const map = new Map<string, UiGuideText>();
  try {
    const supabase = await createClient();
    let query = supabase
      .from("ui_guide_texts")
      .select("guide_key, title, body, surface")
      .eq("enabled", true);
    if (keys?.length) {
      query = query.in("guide_key", keys);
    }
    const { data, error } = await query;
    if (error || !data) return map;
    for (const row of data) {
      map.set(row.guide_key, {
        guide_key: row.guide_key,
        title: row.title,
        body: row.body,
        surface: row.surface,
      });
    }
  } catch {
    /* Tabelle fehlt vor Migration — UI bleibt nutzbar ohne Hint */
  }
  return map;
}

export async function getUiGuideText(
  key: string,
): Promise<UiGuideText | null> {
  const map = await loadUiGuideTexts([key]);
  return map.get(key) ?? null;
}
