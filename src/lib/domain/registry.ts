import type { DomainProfile, DomainProfileId } from "@/lib/domain/types";
import { DOMAIN_PROFILE_IDS } from "@/lib/domain/types";
import { SAP_DOMAIN_PROFILE } from "@/lib/domain/profiles/sap";
import {
  DATABASE_DOMAIN_PROFILE,
  GENERIC_DOCUMENTS_DOMAIN_PROFILE,
  SHAREPOINT_DOMAIN_PROFILE,
  WEBSITE_DOMAIN_PROFILE,
} from "@/lib/domain/profiles/generic";

export const DOMAIN_PROFILE_REGISTRY: Record<DomainProfileId, DomainProfile> = {
  sap: SAP_DOMAIN_PROFILE,
  website: WEBSITE_DOMAIN_PROFILE,
  database: DATABASE_DOMAIN_PROFILE,
  sharepoint: SHAREPOINT_DOMAIN_PROFILE,
  generic_documents: GENERIC_DOCUMENTS_DOMAIN_PROFILE,
};

/**
 * Resolve a domain profile by id.
 * Unknown/missing ids resolve to `generic_documents` — never silently to SAP.
 */
export function resolveDomainProfile(
  id: DomainProfileId | string | null | undefined,
): DomainProfile {
  if (id && (DOMAIN_PROFILE_IDS as readonly string[]).includes(id)) {
    return DOMAIN_PROFILE_REGISTRY[id as DomainProfileId];
  }
  return DOMAIN_PROFILE_REGISTRY.generic_documents;
}

export function isDomainProfileId(id: string | null | undefined): id is DomainProfileId {
  return Boolean(id && (DOMAIN_PROFILE_IDS as readonly string[]).includes(id));
}

export function listDomainProfiles(): DomainProfile[] {
  return DOMAIN_PROFILE_IDS.map((id) => DOMAIN_PROFILE_REGISTRY[id]);
}
