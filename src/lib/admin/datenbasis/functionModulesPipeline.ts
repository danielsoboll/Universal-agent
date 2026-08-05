/**
 * Function-modules Datenbasis pipeline (Detect → Validate → Convert).
 */

import {
  FUNCTION_MODULES_DOMAIN,
} from "@/lib/ingest/sapRepoCodeCanonical";
import { createRepoCodePipeline } from "@/lib/admin/datenbasis/repoCodePipeline";

const pipeline = createRepoCodePipeline(FUNCTION_MODULES_DOMAIN);

export const detectFunctionModulesRaw = pipeline.detectRaw;
export const validateFunctionModulesJsonl = pipeline.validateJsonl;
export const convertFunctionModules = pipeline.convert;
export const buildFunctionModulesTestQuestions = pipeline.buildTestQuestions;
export const runFunctionModulesRagTestSkipped = pipeline.ragTestSkipped;
