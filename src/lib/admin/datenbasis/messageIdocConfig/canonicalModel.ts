/**
 * Canonical model skeleton for MESSAGE_IDOC_CONFIG.
 * RAW groups are transport containers — not identical to canonical objects.
 */

import {
  CANONICAL_OBJECT_TYPES,
  CONFIGURATION_RELATION_KINDS,
  type MessageIdocCanonicalObjectType,
  type MessageIdocRelationKind,
} from "@/lib/admin/datenbasis/messageIdocConfig/constants";
import type {
  MessageIdocCanonicalObjectSkeleton,
  MessageIdocConfigurationRelationSkeleton,
} from "@/lib/admin/datenbasis/messageIdocConfig/types";

export function emptyCanonicalObject(
  objectType: MessageIdocCanonicalObjectType,
): MessageIdocCanonicalObjectSkeleton {
  return {
    object_type: objectType,
    object_id: null,
    display_name: null,
    source: {
      raw_file: null,
      config_group: null,
      source_table: null,
      raw_row_hint: null,
    },
    attributes: {},
  };
}

export function emptyConfigurationRelation(
  kind: MessageIdocRelationKind,
): MessageIdocConfigurationRelationSkeleton {
  return {
    relation_kind: kind,
    from_object_type: null,
    from_object_id: null,
    to_object_type: null,
    to_object_id: null,
    attributes: {},
  };
}

export function describePlannedCanonicalModel(): {
  object_types: readonly MessageIdocCanonicalObjectType[];
  relation_kinds: readonly MessageIdocRelationKind[];
  note: string;
} {
  return {
    object_types: CANONICAL_OBJECT_TYPES,
    relation_kinds: CONFIGURATION_RELATION_KINDS,
    note:
      "Die zehn RAW-Gruppen sind Transportcontainer. Canonical-Typen sind generisch vorbereitet — Mapping erst nach Analyse des echten SAP-Testexports.",
  };
}
