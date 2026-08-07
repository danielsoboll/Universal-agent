/**
 * Load MARA master-data hints for a set of material numbers from Datenbasis.
 * No index rebuild — one streaming pass over canonical MARA content.jsonl.
 */
import { resolveWritablePath } from "@/lib/localData/paths";
import { streamJsonlObjects } from "@/lib/knowledge/multiSourceSearch/streamJsonl";

export type MaterialMasterHint = {
  matnr: string;
  found: boolean;
  mtart: string | null;
  matkl: string | null;
  meins: string | null;
  spart: string | null;
  /** Always true for this Datenbasis — MAKT not exported. */
  description_missing: true;
};

function matKey(s: string): string {
  const t = s.trim();
  if (/^\d+$/.test(t)) return t.replace(/^0+/, "") || "0";
  return t.toUpperCase();
}

function field(values: Record<string, unknown>, key: string): string | null {
  const v = values[key] ?? values[key.toLowerCase()];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

/**
 * Look up MARA rows for the given material numbers (any leading-zero form).
 */
export async function loadMaterialMasterHints(params: {
  projectKey: string;
  materialNumbers: string[];
}): Promise<{
  byKey: Map<string, MaterialMasterHint>;
  scanned: number;
  hits: number;
  path: string;
}> {
  const wanted = new Map<string, string>();
  for (const n of params.materialNumbers) {
    const k = matKey(n);
    if (!wanted.has(k)) wanted.set(k, n);
  }

  const byKey = new Map<string, MaterialMasterHint>();
  for (const [k, original] of wanted) {
    byKey.set(k, {
      matnr: original,
      found: false,
      mtart: null,
      matkl: null,
      meins: null,
      spart: null,
      description_missing: true,
    });
  }

  const path = resolveWritablePath(
    params.projectKey,
    "canonical",
    "master-data/materials/MARA/content.jsonl",
  );

  let scanned = 0;
  let hits = 0;
  let remaining = wanted.size;

  if (remaining === 0) {
    return { byKey, scanned, hits, path };
  }

  for await (const row of streamJsonlObjects(path)) {
    scanned += 1;
    const values =
      row.values && typeof row.values === "object" && !Array.isArray(row.values)
        ? (row.values as Record<string, unknown>)
        : row;
    const matnr = field(values as Record<string, unknown>, "MATNR");
    if (!matnr) continue;
    const k = matKey(matnr);
    if (!wanted.has(k)) continue;
    const prev = byKey.get(k);
    if (!prev || prev.found) continue;
    byKey.set(k, {
      matnr: prev.matnr,
      found: true,
      mtart: field(values as Record<string, unknown>, "MTART"),
      matkl: field(values as Record<string, unknown>, "MATKL"),
      meins: field(values as Record<string, unknown>, "MEINS"),
      spart: field(values as Record<string, unknown>, "SPART"),
      description_missing: true,
    });
    hits += 1;
    remaining -= 1;
    if (remaining <= 0) break;
  }

  return { byKey, scanned, hits, path };
}

export function matnrLookupKey(s: string): string {
  return matKey(s);
}
