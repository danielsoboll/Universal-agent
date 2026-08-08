export type {
  FieldSeedEnrichment,
  FieldSeedRef,
  PresentationHint,
  PresentationHintResult,
  SeedEnrichmentPack,
} from "@/lib/knowledge/seedEnrichment/types";
export { classifyPresentationHint } from "@/lib/knowledge/seedEnrichment/classifyPresentationHint";
export {
  enrichConfirmedFieldSeeds,
  parseFieldLikeSeeds,
} from "@/lib/knowledge/seedEnrichment/enrichConfirmedFieldSeeds";
export {
  enrichmentPackToHits,
  formatSeedEnrichmentPromptBlock,
} from "@/lib/knowledge/seedEnrichment/formatEnrichment";
export { applySeedEnrichmentToAnswer } from "@/lib/knowledge/seedEnrichment/applyEnrichmentToAnswer";
export {
  isConfirmedSeedEvidenceHit,
  hasDeterministicSeedEvidence,
  mergePreserveConfirmedSeedEvidence,
} from "@/lib/knowledge/seedEnrichment/confirmedSeedEvidence";
