/**
 * Vendors (Lieferantenstammdaten) pipeline — domain config over shared master-data core.
 */

import {
  VENDORS_DOMAIN,
} from "@/lib/admin/datenbasis/masterDataDomain";
import {
  createMasterDataPipeline,
} from "@/lib/admin/datenbasis/masterDataPipeline";

export const VENDORS_SET_TOKEN = VENDORS_DOMAIN.setToken;
export const VENDORS_TABLES = VENDORS_DOMAIN.tables;

const pipeline = createMasterDataPipeline(VENDORS_DOMAIN);

export const detectVendorsRaw = pipeline.detectRaw;
export const validateVendorsJsonl = pipeline.validateJsonl;
export const convertVendors = pipeline.convert;
export const buildVendorsTestQuestions = pipeline.buildTestQuestions;
export const runVendorsRagTestSkipped = pipeline.runRagTestSkipped;
