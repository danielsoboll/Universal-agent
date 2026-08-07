export { buildPortableIndex } from "@/lib/portableIndex/buildPortableIndex";
export {
  clearPortableIndexCache,
  isPortableIndexReady,
  loadPortableLexicalDocuments,
  loadPortableEvidenceMaps,
  loadPortableGraph,
  lookupPortableSymbols,
  lookupPortableSymbolRecords,
  lookupPortableCodeUsage,
  lookupPortableLiteralsExact,
  lookupPortableGraphNeighbors,
  listPortableLiteralsByField,
  fetchPortableEvidenceByIds,
  loadPortableManifest,
} from "@/lib/portableIndex/indexLoader";
export { searchViaAccessIndexes } from "@/lib/portableIndex/accessIndexSearch";
export {
  detectLiteralQuery,
  isLiteralHardcodeQuestion,
} from "@/lib/portableIndex/literalQuery";
export type { PortableIndexManifest } from "@/lib/portableIndex/types";
export type { PortableLiteralRecord } from "@/lib/portableIndex/literalTypes";
export type {
  KnowledgeRecord,
  IndexRecord,
  KnowledgeRecordType,
  AccessIndexKind,
  DataPipelineStage,
} from "@/lib/portableIndex/knowledgeRecord";
export {
  ACCESS_INDEX_STAGE,
  KNOWLEDGE_RECORD_VERSION,
  DATA_PIPELINE_STAGES,
} from "@/lib/portableIndex/knowledgeRecord";
export { ACCESS_INDEX_ADAPTERS } from "@/lib/portableIndex/adapters/canonicalAdapters";
