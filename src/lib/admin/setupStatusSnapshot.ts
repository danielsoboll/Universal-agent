import "server-only";
import { existsSync, readFileSync, statSync } from "fs";
import {
  resolveWritablePath,
  writeGeneratedText,
} from "@/lib/localData";
import type { SetupOverview } from "@/lib/admin/setupMainSteps";

/** Small persisted setup progress — safe to read on page render. */
export const SETUP_STATUS_SNAPSHOT_RELATIVE = "setup_status_snapshot.json";

export type SetupStatusSnapshot = SetupOverview & {
  version: 1;
  updatedAt: string;
  customerId: string;
};

function isSetupOverviewShape(value: unknown): value is SetupOverview {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.projectKey === "string" &&
    typeof o.overallPercent === "number" &&
    typeof o.doneCount === "number" &&
    typeof o.totalCount === "number" &&
    typeof o.overallSentence === "string" &&
    Array.isArray(o.steps)
  );
}

/**
 * Read the last admin-refreshed setup snapshot (one small JSON file).
 * Never reconciles disk, never scans canonical/indexes/embeddings.
 */
export function readSetupStatusSnapshot(
  projectKey: string,
): SetupStatusSnapshot | null {
  try {
    const abs = resolveWritablePath(
      projectKey,
      "logs",
      SETUP_STATUS_SNAPSHOT_RELATIVE,
    );
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    const raw = readFileSync(abs, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.version !== 1) return null;
    if (!isSetupOverviewShape(parsed)) return null;
    if (typeof rec.updatedAt !== "string") return null;
    if (typeof rec.customerId !== "string") return null;
    return parsed as SetupStatusSnapshot;
  } catch {
    return null;
  }
}

/** Persist overview after an explicit admin refresh (heavy reconcile already done). */
export function writeSetupStatusSnapshot(opts: {
  customerId: string;
  overview: SetupOverview;
}): string {
  const payload: SetupStatusSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    customerId: opts.customerId,
    ...opts.overview,
  };
  return writeGeneratedText(
    opts.overview.projectKey,
    "logs",
    SETUP_STATUS_SNAPSHOT_RELATIVE,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

/** Strip snapshot metadata for UI components that expect SetupOverview. */
export function snapshotToOverview(
  snapshot: SetupStatusSnapshot,
): SetupOverview {
  return {
    projectKey: snapshot.projectKey,
    steps: snapshot.steps,
    doneCount: snapshot.doneCount,
    totalCount: snapshot.totalCount,
    overallPercent: snapshot.overallPercent,
    overallSentence: snapshot.overallSentence,
    nextStepId: snapshot.nextStepId,
    localDataError: snapshot.localDataError,
  };
}
