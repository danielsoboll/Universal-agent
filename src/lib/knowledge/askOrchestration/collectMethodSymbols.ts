/**
 * Collect METHOD_SYMBOL texts that overlap query terms (for field extraction).
 */
import { loadKnowledgeGraph } from "@/lib/knowledge/graphSelector/loadGraph";
import { normalizeQueryTerms } from "./orchestrationRelevanceGate";

export async function collectRelatedMethodSymbols(params: {
  projectKey: string;
  query_terms: string[];
  limit?: number;
}): Promise<string[]> {
  const terms = normalizeQueryTerms(params.query_terms);
  if (terms.length === 0) return [];
  const graph = await loadKnowledgeGraph(params.projectKey);
  const out: string[] = [];
  const seen = new Set<string>();
  const limit = params.limit ?? 400;
  for (const node of graph.nodes.values()) {
    if (
      node.object_type !== "METHOD_SYMBOL" &&
      node.object_type !== "CLASS_METHOD_SYMBOL"
    ) {
      continue;
    }
    const u = node.name.toUpperCase();
    if (!terms.some((t) => u.includes(t))) continue;
    if (seen.has(node.name)) continue;
    seen.add(node.name);
    out.push(node.name);
    if (out.length >= limit) break;
  }
  return out;
}
