/**
 * Verbindliche Auflösung des Dateisystem-Projektkeys unter LOCAL_DATA_ROOT.
 *
 * Dieses Repo (universal-agent) ist fest auf P01 verdrahtet.
 * UI-Slug (z. B. früher dgl-z-analyse) wird ignoriert — kein Parallelordner.
 *
 * Erzeugt keine Ordner und kopiert/verschiebt keine Dateien.
 */
import path from "path";
import { BOUND_DATA_PROJECT_KEY } from "@/lib/localData/boundProject";
import { getLocalDataRoot } from "@/lib/localData/root";
import { PROJECT_KEY_PATTERN } from "@/lib/localData/zones";

export type DataProjectKeyResolution = {
  /** Verbindlicher Ordnername unter LOCAL_DATA_ROOT */
  projectKey: string;
  projectRoot: string;
  localDataRoot: string;
  source: "bound_universal_agent";
  /** Roh-Eingaben zur Diagnose (werden für den Root nicht verwendet). */
  inputs: {
    slug: string | null;
    landscape_label: string | null;
    customer_id: string | null;
    hint: string | null;
    env_data_key: string | null;
  };
  rejected_slug_path: string | null;
};

/**
 * Immer P01 — einziger Datenroot für universal-agent.
 */
export function resolveDataProjectKey(params?: {
  slug?: string | null;
  landscapeLabel?: string | null;
  customerId?: string | null;
  hint?: string | null;
}): DataProjectKeyResolution {
  const localDataRoot = getLocalDataRoot();
  const slug = params?.slug?.trim() || null;
  const landscape_label = params?.landscapeLabel?.trim() || null;
  const customer_id = params?.customerId?.trim() || null;
  const hint = params?.hint?.trim() || null;
  const env_data_key =
    process.env.LOCAL_KNOWLEDGE_DATA_KEY?.trim() ||
    process.env.PIPELINE_PROJECT_KEY?.trim() ||
    null;

  const rejected_slug_path =
    slug &&
    PROJECT_KEY_PATTERN.test(slug) &&
    slug !== BOUND_DATA_PROJECT_KEY
      ? path.resolve(localDataRoot, slug)
      : null;

  return {
    projectKey: BOUND_DATA_PROJECT_KEY,
    projectRoot: path.resolve(localDataRoot, BOUND_DATA_PROJECT_KEY),
    localDataRoot,
    source: "bound_universal_agent",
    inputs: { slug, landscape_label, customer_id, hint, env_data_key },
    rejected_slug_path,
  };
}

/** Kurzform: immer P01. */
export function resolveBoundProjectKey(_params?: {
  slug?: string | null;
  landscapeLabel?: string | null;
  customerId?: string | null;
  hint?: string | null;
}): string {
  return BOUND_DATA_PROJECT_KEY;
}
