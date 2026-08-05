/**
 * Programs Datenbasis pipeline (Detect → Validate → Convert).
 */

import {
  PROGRAMS_DOMAIN,
} from "@/lib/ingest/sapRepoCodeCanonical";
import { createRepoCodePipeline } from "@/lib/admin/datenbasis/repoCodePipeline";

const pipeline = createRepoCodePipeline(PROGRAMS_DOMAIN);

export const detectProgramsRaw = pipeline.detectRaw;
export const validateProgramsJsonl = pipeline.validateJsonl;
export const convertPrograms = pipeline.convert;
export const buildProgramsTestQuestions = pipeline.buildTestQuestions;
export const runProgramsRagTestSkipped = pipeline.ragTestSkipped;
