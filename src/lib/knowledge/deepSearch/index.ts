/**
 * KI-Tiefensuche — Query Understanding, Search Plan, Multi-Source.
 *
 * Customer-specific expected anchors (field names, brands, sample objects)
 * belong ONLY in regression tests under tests/. Production retrieval must
 * derive plans from Query Understanding + generic rules + coverage + evidence.
 */
export type * from "@/lib/knowledge/deepSearch/types";
export {
  runQueryUnderstanding,
  validateAndEnrichQueryUnderstanding,
} from "@/lib/knowledge/deepSearch/queryUnderstanding";
export { selectSearchPlan } from "@/lib/knowledge/deepSearch/selectSearchPlan";
export {
  runDeepSearch,
  multiSourceToModeMetrics,
} from "@/lib/knowledge/deepSearch/runDeepSearch";
export { compareDirectAndDeepSearch } from "@/lib/knowledge/deepSearch/compareModes";
