/**
 * Customers (Kundenstammdaten) pipeline — domain config over shared master-data core.
 */

import {
  CUSTOMERS_DOMAIN,
} from "@/lib/admin/datenbasis/masterDataDomain";
import {
  createMasterDataPipeline,
} from "@/lib/admin/datenbasis/masterDataPipeline";

export const CUSTOMERS_SET_TOKEN = CUSTOMERS_DOMAIN.setToken;
export const CUSTOMERS_TABLES = CUSTOMERS_DOMAIN.tables;

const pipeline = createMasterDataPipeline(CUSTOMERS_DOMAIN);

export const detectCustomersRaw = pipeline.detectRaw;
export const validateCustomersJsonl = pipeline.validateJsonl;
export const convertCustomers = pipeline.convert;
export const buildCustomersTestQuestions = pipeline.buildTestQuestions;
export const runCustomersRagTestSkipped = pipeline.runRagTestSkipped;
