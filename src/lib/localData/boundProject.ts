/**
 * Universal Knowledge Analyzer (universal-agent / general-agent).
 * Ein verbindlicher Daten-Projektordner unter LOCAL_DATA_ROOT — fest verdrahtet.
 *
 * UI-Slug, Vercel-Projektname und Supabase-Kundenname sind unabhängig davon.
 * Alle Fahrplan-/Status-/Pipeline-/RAG-Pfade nutzen diesen Key.
 */
export const BOUND_DATA_PROJECT_KEY = "P01" as const;

export type BoundDataProjectKey = typeof BOUND_DATA_PROJECT_KEY;
