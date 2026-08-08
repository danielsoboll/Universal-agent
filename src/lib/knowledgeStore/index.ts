/**
 * Knowledge Store boundary — UI never touches LOCAL_DATA_ROOT.
 *
 * UI → API / Server Action → KnowledgeStore interface → adapter
 *
 * Current adapter: local portable indices under LOCAL_DATA_ROOT
 * Future adapters: Azure / Supabase / Postgres (same interface)
 *
 * Rule: NO KNOWLEDGE LOADING ON RENDER — see docs/LAZY_KNOWLEDGE.md
 */

export type KnowledgeStoreAdapterId = "local_data_root" | "remote";

/**
 * Marker interface for the store boundary.
 * Ask/retrieval implementations live behind API routes and call adapters
 * only inside request handlers — never from RSC page modules.
 */
export type KnowledgeStoreBoundary = {
  adapter: KnowledgeStoreAdapterId;
  /** Human-readable note for ops / future migration */
  note: string;
};

export const LOCAL_KNOWLEDGE_STORE: KnowledgeStoreBoundary = {
  adapter: "local_data_root",
  note: "Local adapter reads LOCAL_DATA_ROOT via src/lib/localData + portable indices. UI components must not import this path.",
};
