/**
 * Anchor set helpers — dedupe, merge, strength checks.
 */
import type { SearchAnchor } from "@/lib/knowledge/multiSourceSearch/types";
import { normalizeToken } from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import { anchorKey } from "@/lib/knowledge/multiSourceSearch/plan";

export function makeAnchor(params: {
  kind: SearchAnchor["kind"];
  value: string;
  source: SearchAnchor["source"];
  confidence: number;
  note?: string;
}): SearchAnchor | null {
  const value = params.value.trim();
  if (value.length < 2) return null;
  return {
    kind: params.kind,
    value,
    norm: normalizeToken(value),
    source: params.source,
    confidence: params.confidence,
    note: params.note,
  };
}

export class AnchorSet {
  private byKey = new Map<string, SearchAnchor>();

  add(anchor: SearchAnchor | null | undefined): boolean {
    if (!anchor) return false;
    const key = anchorKey(anchor.kind, anchor.norm);
    const existing = this.byKey.get(key);
    if (!existing) {
      this.byKey.set(key, anchor);
      return true;
    }
    if (anchor.confidence > existing.confidence) {
      this.byKey.set(key, { ...existing, ...anchor });
      return false; // not "new" but upgraded
    }
    return false;
  }

  addMany(anchors: SearchAnchor[]): SearchAnchor[] {
    const neu: SearchAnchor[] = [];
    for (const a of anchors) {
      if (this.add(a)) neu.push(a);
    }
    return neu;
  }

  list(): SearchAnchor[] {
    return [...this.byKey.values()].sort(
      (a, b) => b.confidence - a.confidence,
    );
  }

  valuesOfKinds(kinds: SearchAnchor["kind"][]): string[] {
    const set = new Set(kinds);
    return this.list()
      .filter((a) => set.has(a.kind))
      .map((a) => a.value);
  }

  /** Strong anchors suitable for targeted CT/code queries. */
  strongNeedles(): string[] {
    const GENERIC = new Set([
      "AUART",
      "VKORG",
      "VTWEG",
      "SPART",
      "WERKS",
      "LGORT",
      "MANDT",
      "BUKRS",
      "X",
      "Y",
      "N",
    ]);
    return this.list()
      .filter(
        (a) =>
          a.confidence >= 0.55 &&
          a.norm.length >= 3 &&
          !GENERIC.has(a.norm) &&
          (a.kind === "field" ||
            a.kind === "value" ||
            a.kind === "table" ||
            a.kind === "object" ||
            a.kind === "symbol" ||
            a.kind === "key"),
      )
      .map((a) => a.value);
  }

  allNeedles(): string[] {
    return [...new Set(this.list().map((a) => a.value))];
  }

  get size(): number {
    return this.byKey.size;
  }
}

export function isZLikeField(name: string): boolean {
  const n = name.trim().toUpperCase();
  return (
    /^(Z|Y|ZZ|YY)/.test(n) ||
    n.includes("_Z") ||
    n.startsWith("/") // namespace
  );
}
