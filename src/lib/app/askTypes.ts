import type {
  CompactTechnicalDetails,
  ProcessAnswer,
  TechnicalAnswer,
  TechnicalDetails,
} from "@/lib/knowledge/answerSchema";
import type { QueryPlan, SearchMode } from "@/lib/knowledge/queryPlanSchema";
import type { EntityGroundingResult } from "@/lib/knowledge/entityGrounding";
import type { FullAnalysisReport } from "@/lib/knowledge/fullAnalysisReport";

export type AskEvidenceRef = {
  title: string;
  sourceKey?: string;
  snippet?: string;
  rank?: number;
  score?: number;
  exactScore?: number;
  fulltextScore?: number;
  vectorScore?: number;
  knowledgeUnitType?: string;
  objectLabel?: string;
  objectType?: string;
  objectName?: string;
  subobjectName?: string;
  evidenceRefs?: string[];
  facts?: string[];
  inferences?: string[];
  tablesRead?: string[];
  tablesWritten?: string[];
  calledMethods?: string[];
  hardcodedValues?: string[];
  evidence?: Array<{
    statement_type: string;
    text?: string;
    lines?: Array<{ line?: number; quote?: string }>;
  }>;
  confidence?: number | null;
};

export type AskQuestionInput = {
  question: string;
  customerId?: string | null;
  searchMode?: SearchMode;
};

export type AskQuestionResult = {
  status: "ok" | "insufficient" | "error" | "not_connected";
  answer: string | null;
  reasoning?: string | null;
  processAnswer?: ProcessAnswer | null;
  technicalAnswer?: TechnicalAnswer | null;
  technicalDetails?: TechnicalDetails | null;
  compactTechnicalDetails?: CompactTechnicalDetails | null;
  questionIntent?: string | null;
  entityGrounding?: EntityGroundingResult[];
  relevanceGate?: {
    answerability: "answerable" | "partially_answerable" | "insufficient";
    queryConcepts: string[];
    matchedConcepts: string[];
    missingConcepts: string[];
    supportingSourceIds: string[];
    contradictingSourceIds: string[];
    similarButInsufficientSourceIds: string[];
    reason: string;
  } | null;
  evidence: AskEvidenceRef[];
  message: string;
  retrievalMode?: string;
  searchedDocumentCount?: number;
  topScore?: number | null;
  vectorSearchActive?: boolean;
  model?: string;
  tokenUsage?: { input: number; output: number; embedding: number };
  estimatedCost?: number;
  warnings?: string[];
  indexPath?: string;
  searchMode?: SearchMode;
  requestedSearchMode?: SearchMode;
  queryPlan?: QueryPlan | null;
  subqueryCount?: number;
  plannerFallback?: boolean;
  durationMs?: number;
  /** Always false on /app/ask — each question is an isolated knowledge query. */
  conversationMode?: false;
  domainProfileId?: string;
  promptKey?: string;
  promptVersion?: string;
  searchProfileId?: string;
  /** full_analysis only — Markdown + Word for download. */
  fullAnalysisReport?: FullAnalysisReport | null;
};
