export {
  PIPELINE_TYPE,
  EXPECTED_EXPORT_TYPE,
  EXPECTED_GROUPS,
  CONFIG_GROUPS,
  EXPECTED_SOURCE_TABLES,
  RAW_FOLDER,
  CANONICAL_FOLDER,
  LOG_FOLDER,
  CANONICAL_OBJECT_TYPES,
  CONFIGURATION_RELATION_KINDS,
  EXCLUDED_MOVEMENT_HINTS,
  AREA_STATUS_VALUES,
  AREA_STATUS_LABELS,
  isConfigGroup,
  type MessageIdocAreaStatus,
  type MessageIdocConfigGroup,
  type MessageIdocCanonicalObjectType,
  type MessageIdocRelationKind,
  type MessageIdocFileFormalStatus,
} from "@/lib/admin/datenbasis/messageIdocConfig/constants";

export type {
  DetectedMessageIdocFile,
  TableSchemaProfile,
  MessageIdocRawManifest,
  MessageIdocFileManifestEntry,
  MessageIdocStatusSnapshot,
  MessageIdocCanonicalObjectSkeleton,
  MessageIdocConfigurationRelationSkeleton,
} from "@/lib/admin/datenbasis/messageIdocConfig/types";

export {
  detectMessageIdocRawFiles,
  extractConfigGroupFromFileName,
} from "@/lib/admin/datenbasis/messageIdocConfig/detectRaw";

export {
  validateAndProfileJsonlFile,
  validateHeaderObject,
  looksLikeTechnicalObjectName,
  schemaProfileKey,
  formalStatusLabel,
} from "@/lib/admin/datenbasis/messageIdocConfig/validateAndProfile";

export {
  ensureMessageIdocConfigFolders,
  prepareMessageIdocConfig,
  loadMessageIdocRawManifest,
  loadMessageIdocStatus,
  deriveAreaStatus,
  type PrepareMessageIdocResult,
} from "@/lib/admin/datenbasis/messageIdocConfig/runPrepare";

export {
  emptyCanonicalObject,
  emptyConfigurationRelation,
  describePlannedCanonicalModel,
} from "@/lib/admin/datenbasis/messageIdocConfig/canonicalModel";
