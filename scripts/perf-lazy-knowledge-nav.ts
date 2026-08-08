/**
 * Measure render-path FS cost: before (full disk reconcile) vs after (lazy snapshot/metadata).
 * Does not start Ask retrieval or touch Background Enrichment outputs.
 *
 * Usage: npx tsx scripts/perf-lazy-knowledge-nav.ts
 */
import Module from "module";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { createRequire } from "module";
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";

loadEnvFile(resolve(process.cwd(), ".env.local"));

// Allow importing server-only modules from CLI measurement.
const mod = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad(request, parent, isMain);
};

type FsStats = {
  readFileCalls: number;
  readFileBytes: number;
  readdirCalls: number;
  pathsSample: string[];
};

function installFsProbe(): { stats: FsStats; restore: () => void } {
  const fs = createRequire(import.meta.url)("fs") as typeof import("fs");
  const stats: FsStats = {
    readFileCalls: 0,
    readFileBytes: 0,
    readdirCalls: 0,
    pathsSample: [],
  };
  const notePath = (p: unknown) => {
    if (typeof p === "string" && stats.pathsSample.length < 16) {
      stats.pathsSample.push(p);
    }
  };
  const origReadFileSync = fs.readFileSync.bind(fs);
  const origReaddirSync = fs.readdirSync.bind(fs);

  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    notePath(args[0]);
    stats.readFileCalls += 1;
    const result = origReadFileSync(...args);
    if (typeof result === "string") stats.readFileBytes += Buffer.byteLength(result);
    else if (Buffer.isBuffer(result)) stats.readFileBytes += result.length;
    return result;
  }) as typeof fs.readFileSync;

  (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = ((
    ...args: Parameters<typeof fs.readdirSync>
  ) => {
    notePath(args[0]);
    stats.readdirCalls += 1;
    return origReaddirSync(...args);
  }) as typeof fs.readdirSync;

  return {
    stats,
    restore: () => {
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync =
        origReadFileSync;
      (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = origReaddirSync;
    },
  };
}

function looksLikeKnowledgePath(p: string): boolean {
  return /\/(canonical|analyses|embeddings|indexes|knowledge|search-documents|control.?tables)\b/i.test(
    p,
  );
}

async function measure(
  label: string,
  fn: () => Promise<unknown> | unknown,
): Promise<Record<string, unknown>> {
  const probe = installFsProbe();
  const t0 = performance.now();
  let error: string | null = null;
  let resultSummary: unknown = null;
  try {
    resultSummary = await fn();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  probe.restore();
  const knowledgeHits = probe.stats.pathsSample.filter(looksLikeKnowledgePath);
  return {
    label,
    ms,
    error,
    files_read: probe.stats.readFileCalls,
    bytes_read: probe.stats.readFileBytes,
    readdir_calls: probe.stats.readdirCalls,
    knowledge_loader_paths_seen: knowledgeHits.length > 0,
    disk_reconcile_likely:
      probe.stats.readFileCalls > 20 || probe.stats.readdirCalls > 30,
    path_sample: probe.stats.pathsSample.slice(0, 10),
    result: resultSummary,
  };
}

async function main() {
  const projectKey = "P01";
  const customerId = "perf-lazy-customer";
  const selected = {
    id: customerId,
    name: "DGL Z-Analyse",
    slug: "P01",
    status: "active" as string | null,
    product_module: null as string | null,
    landscape_label: null as string | null,
  };

  const { computeSetupOverview } = await import("@/lib/admin/setupMainSteps");
  const {
    readSetupStatusSnapshot,
    writeSetupStatusSnapshot,
    snapshotToOverview,
  } = await import("@/lib/admin/setupStatusSnapshot");
  const { buildAppOverviewLightweight } = await import(
    "@/lib/admin/loadAppOverview"
  );
  const { loadCachedDashboardOverview, loadCachedOverallPercent } =
    await import("@/lib/admin/loadDashboardSetup");

  const setupCtx = {
    customerId,
    customerName: selected.name,
    customerSlug: selected.slug,
    customerStatus: selected.status,
    productModule: null,
    projectKey,
    hasGoals: true,
    membershipCount: 2,
    userMembershipCount: 1,
  };

  const before = await measure(
    "BEFORE computeSetupOverview (disk reconcile = old /app+/admin render)",
    () => {
      const o = computeSetupOverview(setupCtx);
      return {
        overallPercent: o.overallPercent,
        doneCount: o.doneCount,
        steps: o.steps.length,
        localDataError: o.localDataError,
      };
    },
  );

  const refresh = await measure(
    "ADMIN writeSetupStatusSnapshot after reconcile (explicit action)",
    () => {
      const o = computeSetupOverview(setupCtx);
      writeSetupStatusSnapshot({ customerId, overview: o });
      return { overallPercent: o.overallPercent };
    },
  );

  const afterApp = await measure(
    "AFTER buildAppOverviewLightweight (/app render)",
    async () => {
      const o = await buildAppOverviewLightweight({
        ctx: { productModule: null } as never,
        customerId,
        selected,
      });
      return {
        source: o.source,
        overallPercent: o.overallPercent,
        updatedAt: o.updatedAt,
      };
    },
  );

  const afterAdmin = await measure(
    "AFTER loadCachedDashboardOverview (/admin/dashboard render)",
    () => {
      const c = loadCachedDashboardOverview({ customerId, selected });
      return {
        source: c.source,
        overallPercent: c.overview?.overallPercent ?? null,
        updatedAt: c.updatedAt,
        steps: c.overview?.steps.length ?? 0,
      };
    },
  );

  const afterList = await measure(
    "AFTER list percents ×5 (cached only; was N× reconcile)",
    () => {
      const customers = Array.from({ length: 5 }, (_, i) => ({
        ...selected,
        id: `${customerId}-${i}`,
      }));
      // Same projectKey/snapshot for P01-bound key — still only small JSON reads
      return customers.map((c) =>
        loadCachedOverallPercent({ customerId: c.id, selected: c }),
      );
    },
  );

  const snap = readSetupStatusSnapshot(projectKey);

  const report = {
    generatedAt: new Date().toISOString(),
    projectKey,
    note:
      "FS probe of server overview functions (not HTTP). Background Enrichment untouched. Navigation A–D in browser should mirror AFTER rows.",
    snapshot_present: Boolean(snap),
    snapshot_updated_at: snap?.updatedAt ?? null,
    steps: [before, refresh, afterApp, afterAdmin, afterList],
    navigation_mapping: {
      "A_login_to_app": "AFTER buildAppOverviewLightweight",
      "B_app_to_ask": "no overview/reconcile (Ask page auth+panel only)",
      "C_ask_to_sources_history": "no knowledge load on render",
      "D_back_to_app": "AFTER buildAppOverviewLightweight",
    },
    verdict: {
      app_render_independent_of_knowledge_size:
        (afterApp.files_read as number) <= 5 &&
        afterApp.knowledge_loader_paths_seen === false &&
        afterApp.disk_reconcile_likely === false,
      admin_render_no_reconcile:
        (afterAdmin.files_read as number) <= 5 &&
        afterAdmin.disk_reconcile_likely === false,
      before_was_heavy:
        (before.files_read as number) > 20 ||
        (before.readdir_calls as number) > 30 ||
        (before.ms as number) > 200,
      speedup_ms:
        typeof before.ms === "number" && typeof afterApp.ms === "number"
          ? Math.round(((before.ms as number) - (afterApp.ms as number)) * 10) /
            10
          : null,
      bytes_before: before.bytes_read,
      bytes_after_app: afterApp.bytes_read,
    },
  };

  const outDir = path.join(process.cwd(), "tmp/regression");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "lazy-knowledge-nav-perf.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);

  // silence unused
  void snapshotToOverview;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
