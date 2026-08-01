import type { HybridSearchHit } from "@/lib/search/hybridSearch";
import type {
  SearchEntity,
  SearchEvidence,
  SearchRelation,
} from "@/lib/search/searchDocumentSchema";

export type KnowledgeHit = HybridSearchHit & {
  facts: string[];
  inferences: string[];
  metadata: Record<string, unknown>;
  object_name: string;
  object_type: string;
  subobject_name: string;
  technical_summary: string;
  business_purpose: string;
  tables_read: string[];
  tables_written: string[];
  called_methods: string[];
  called_functions: string[];
  hardcoded_values: string[];
  entities: SearchEntity[];
  relations: SearchRelation[];
  evidence: SearchEvidence[];
  /** Document-level confidence from analysis. */
  doc_confidence: number | null;
};
