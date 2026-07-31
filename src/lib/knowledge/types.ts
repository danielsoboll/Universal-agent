import type { HybridSearchHit } from "@/lib/search/hybridSearch";

export type KnowledgeHit = HybridSearchHit & {
  facts: string[];
  inferences: string[];
  metadata: Record<string, unknown>;
  object_name: string;
  object_type: string;
  subobject_name: string;
  technical_summary: string;
  business_purpose: string;
};
