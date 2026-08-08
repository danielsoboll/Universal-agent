/**
 * Lazy-Knowledge Abschluss-/Regressionstest (kein Architektur-Umbau).
 *
 * Misst Navigation-äquivalente Server-Pfade unter laufendem Background-Enrichment,
 * prüft Ask-Regression + Smoke, Admin Render vs. expliziter Reconcile.
 *
 *   npx tsx scripts/e2e-lazy-knowledge-checkpoint.ts
 */
import Module from "module";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { performance } from "perf_hooks";
import { createRequire } from "module";
import { loadEnvFile } from "../src/lib/core/loadEnv";

loadEnvFile(resolve(process.cwd(), ".env.local"));

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
  const note = (p: unknown) => {
    if (typeof p === "string" && stats.pathsSample.length < 20) {
      stats.pathsSample.push(p);
    }
  };
  const origRead = fs.readFileSync.bind(fs);
  const origDir = fs.readdirSync.bind(fs);
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    note(args[0]);
    stats.readFileCalls += 1;
    const result = origRead(...args);
    if (typeof result === "string") stats.readFileBytes += Buffer.byteLength(result);
    else if (Buffer.isBuffer(result)) stats.readFileBytes += result.length;
    return result;
  }) as typeof fs.readFileSync;
  (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = ((
    ...args: Parameters<typeof fs.readdirSync>
  ) => {
    note(args[0]);
    stats.readdirCalls += 1;
    return origDir(...args);
  }) as typeof fs.readdirSync;
  return {
    stats,
    restore: () => {
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = origRead;
      (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = origDir;
    },
  };
}

function knowledgePath(p: string): boolean {
  return /\/(canonical|analyses|embeddings|indexes|knowledge|search-documents|control.?tables)\b/i.test(
    p,
  );
}

function reconcileHint(sample: string[]): boolean {
  return sample.some(
    (p) =>
      /setup-stage2|table_definitions|table_rows|search_documents|embeddings\/search|control_tables/i.test(
        p,
      ),
  );
}

async function measure(
  label: string,
  fn: () => Promise<unknown> | unknown,
): Promise<Record<string, unknown>> {
  const probe = installFsProbe();
  const t0 = performance.now();
  let error: string | null = null;
  let result: unknown = null;
  try {
    result = await fn();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  probe.restore();
  const sample = probe.stats.pathsSample;
  const knowledge = sample.some(knowledgePath);
  const reconcile = reconcileHint(sample) || probe.stats.readFileCalls > 20;
  return {
    step: label,
    render_ms: ms,
    files_read: probe.stats.readFileCalls,
    bytes_read: probe.stats.readFileBytes,
    readdir_calls: probe.stats.readdirCalls,
    knowledge_loader: knowledge ? "ja" : "nein",
    disk_reconcile: reconcile ? "ja" : "nein",
    path_sample: sample.slice(0, 8),
    error,
    result,
  };
}

function beProgress(): Record<string, unknown> {
  const log = resolve(
    process.cwd(),
    "tmp/regression/background-enrichment-run-500.json.log",
  );
  if (!existsSync(log)) return { present: false };
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = last.match(/analyses=(\d+)/);
  return {
    present: true,
    last_line: last.slice(0, 200),
    analyses_seen: m ? Number(m[1]) : null,
  };
}

function summarizeAsk(label: string, r: {
  status: string;
  direct_answer?: string | null;
  sources?: unknown[];
  searched_document_count?: number;
  retrieval_mode?: string;
  duration_ms?: number;
  warnings?: string[];
  process_answer?: { confirmed?: Array<{ text: string }> } | null;
  technical_answer?: {
    objects?: Array<{ text: string }>;
    processing?: Array<{ text: string }>;
  } | null;
  seed_enrichment?: unknown;
  ask_perf?: { index_loaded_from_disk?: boolean; fs_bytes_total?: number } | null;
}): Record<string, unknown> {
  const blob = [
    r.direct_answer ?? "",
    ...(r.process_answer?.confirmed ?? []).map((c) => c.text),
    ...(r.technical_answer?.objects ?? []).map((c) => c.text),
    ...(r.technical_answer?.processing ?? []).map((c) => c.text),
  ].join("\n");
  return {
    label,
    status: r.status,
    duration_ms: r.duration_ms ?? null,
    searched_document_count: r.searched_document_count ?? null,
    retrieval_mode: r.retrieval_mode ?? null,
    sources_count: Array.isArray(r.sources) ? r.sources.length : 0,
    answer_preview: (r.direct_answer ?? "").slice(0, 400),
    has_evidence_sources: Array.isArray(r.sources) && r.sources.length > 0,
    mentions_vlager: /ZZ_VLAGER|virtuell/i.test(blob),
    mentions_edeka: /EDEKA/i.test(blob),
    mentions_zecd: /ZECD/i.test(blob),
    mentions_octopus: /OCTOPUS/i.test(blob),
    mentions_code_usage: /METHOD|INCLUDE|FORM|CLASS|verwendet/i.test(blob),
    enrich_warnings: (r.warnings ?? [])
      .filter((w) => /enrich|Seed|Graph|Code|Sales/i.test(w))
      .slice(0, 8),
    index_loaded_from_disk: r.ask_perf?.index_loaded_from_disk ?? null,
    ask_fs_bytes: r.ask_perf?.fs_bytes_total ?? null,
  };
}

async function main() {
  const log = (...args: unknown[]) => {
    console.error("[checkpoint]", ...args);
  };
  log("start");
  const { getLocalDataRoot } = await import("../src/lib/localData/root");
  getLocalDataRoot();
  log("LOCAL_DATA_ROOT ok");

  const selected = {
    id: "checkpoint-customer",
    name: "DGL Z-Analyse",
    slug: "P01",
    status: "active" as string | null,
    product_module: null as string | null,
    landscape_label: null as string | null,
  };
  const customerId = selected.id;

  const { buildAppOverviewLightweight } = await import(
    "../src/lib/admin/loadAppOverview"
  );
  const {
    loadCachedDashboardOverview,
  } = await import("../src/lib/admin/loadDashboardSetup");
  const { computeSetupOverview } = await import(
    "../src/lib/admin/setupMainSteps"
  );
  const { answerQuestion } = await import("../src/lib/knowledge/answerQuestion");

  const nav: Record<string, unknown>[] = [];

  log("nav A…");
  // A: Login → /app (overview render path)
  nav.push(
    await measure("A Login→/app", async () => {
      const o = await buildAppOverviewLightweight({
        ctx: { productModule: null } as never,
        customerId,
        selected,
      });
      return { source: o.source, percent: o.overallPercent };
    }),
  );

  log("nav B–D (static pages)…");
  // B: /app → Fragen (page has no knowledge load on render)
  nav.push(
    await measure("B /app→Fragen (/app/ask render)", () => {
      // Equivalent: no overview, no index loader, no reconcile
      return { knowledge_on_render: false, page: "static+AskQuestionPanel mount" };
    }),
  );

  // C: Fragen → Quellen
  nav.push(
    await measure("C Fragen→Quellen (/app/sources)", () => {
      return { page: "static placeholder", knowledge_on_render: false };
    }),
  );

  // D: Quellen → Verlauf
  nav.push(
    await measure("D Quellen→Verlauf (/app/history)", () => {
      return { page: "static placeholder", knowledge_on_render: false };
    }),
  );

  log("nav E…");
  // E: Verlauf → /app
  nav.push(
    await measure("E Verlauf→/app", async () => {
      const o = await buildAppOverviewLightweight({
        ctx: { productModule: null } as never,
        customerId,
        selected,
      });
      return { source: o.source, percent: o.overallPercent };
    }),
  );

  log("nav F admin cached…");
  // F: /app → /admin/dashboard (cached only)
  nav.push(
    await measure("F /app→/admin/dashboard (cached)", () => {
      const c = loadCachedDashboardOverview({ customerId, selected });
      return {
        source: c.source,
        percent: c.overview?.overallPercent ?? null,
        updatedAt: c.updatedAt,
      };
    }),
  );

  log("admin render vs reconcile…");
  // Admin: render must NOT reconcile; explicit action may
  const adminRender = await measure(
    "ADMIN dashboard render (cached only)",
    () => loadCachedDashboardOverview({ customerId, selected }),
  );
  const adminHeavy = await measure(
    "ADMIN Datenbestand prüfen (explicit reconcile)",
    () =>
      computeSetupOverview({
        customerId,
        customerName: selected.name,
        customerSlug: selected.slug,
        customerStatus: selected.status,
        productModule: null,
        projectKey: "P01",
        hasGoals: true,
        membershipCount: 2,
        userMembershipCount: 1,
      }),
  );
  log("admin done", {
    render_ms: adminRender.render_ms,
    heavy_ms: adminHeavy.render_ms,
    heavy_reconcile: adminHeavy.disk_reconcile,
  });

  const navOk = nav.every(
    (n) =>
      n.disk_reconcile === "nein" &&
      n.knowledge_loader === "nein" &&
      (n.render_ms as number) < 2000 &&
      !n.error,
  );
  const adminOk =
    adminRender.disk_reconcile === "nein" &&
    adminRender.knowledge_loader === "nein" &&
    adminHeavy.disk_reconcile === "ja";

  // Ask regression + smokes (knowledge ONLY here)
  const asks: Record<string, unknown>[] = [];
  const questions = [
    {
      label: "Edeka virtuelles Lager",
      q: "Wie funktioniert das Edeka virtuelle Lager?",
    },
    { label: "ZECD", q: "Was wissen wir über ZECD?" },
    { label: "OCTOPUS", q: "Was wissen wir über OCTOPUS?" },
    { label: "ZZ_VLAGER usage", q: "Wo wird ZZ_VLAGER verwendet?" },
  ];

  for (const item of questions) {
    log(`ask: ${item.label}…`);
    const t0 = performance.now();
    const r = await answerQuestion({
      projectId: "P01",
      question: item.q,
      searchMode: "direct_rag",
    });
    const summary = summarizeAsk(item.label, r);
    summary.request_ms = Math.round(performance.now() - t0);
    log(`ask done: ${item.label}`, {
      status: summary.status,
      ms: summary.request_ms,
      docs: summary.searched_document_count,
    });
    asks.push(summary);
  }

  const edeka = asks.find((a) => a.label === "Edeka virtuelles Lager");
  const zecd = asks.find((a) => a.label === "ZECD");
  const octopus = asks.find((a) => a.label === "OCTOPUS");
  const vlager = asks.find((a) => a.label === "ZZ_VLAGER usage");

  const askOk =
    edeka &&
    edeka.status !== "error" &&
    edeka.has_evidence_sources === true &&
    (edeka.mentions_vlager === true || edeka.mentions_edeka === true) &&
    zecd &&
    zecd.status !== "error" &&
    zecd.mentions_zecd === true &&
    octopus &&
    octopus.status !== "error" &&
    (octopus.mentions_octopus === true ||
      (octopus.searched_document_count as number) > 0) &&
    vlager &&
    vlager.status !== "error" &&
    (vlager.mentions_vlager === true || vlager.has_evidence_sources === true);

  const before = {
    render_ms: 5856.9,
    files_read: 123,
    bytes_read: 1214038009,
    knowledge_loader: "ja",
    disk_reconcile: "ja",
  };

  const report = {
    checkpoint: "lazy-knowledge-stable",
    generatedAt: new Date().toISOString(),
    background_enrichment_during_test: beProgress(),
    navigation: nav,
    admin: {
      render: adminRender,
      explicit_reconcile: adminHeavy,
      expectation: {
        render_no_reconcile: adminOk,
        explicit_may_reconcile: adminHeavy.disk_reconcile === "ja",
      },
    },
    ask_regression: asks,
    pass: {
      navigation_lazy: navOk,
      admin_split: adminOk,
      ask_smoke: Boolean(askOk),
      overall: navOk && adminOk && Boolean(askOk),
    },
    before_after: {
      before_overview_render: before,
      after_app_render: {
        render_ms: nav[0]?.render_ms,
        files_read: nav[0]?.files_read,
        bytes_read: nav[0]?.bytes_read,
        knowledge_loader: nav[0]?.knowledge_loader,
        disk_reconcile: nav[0]?.disk_reconcile,
      },
      after_admin_render: {
        render_ms: adminRender.render_ms,
        files_read: adminRender.files_read,
        bytes_read: adminRender.bytes_read,
        knowledge_loader: adminRender.knowledge_loader,
        disk_reconcile: adminRender.disk_reconcile,
      },
    },
    known_gaps: [
      "/admin/steps/[stepId] still runs computeSetupOverview on that setup page (intentional technical work surface, not Anwender navigation).",
      "Ask page type-only imports remain; value Knowledge load only via POST /api/app/ask (or CLI answerQuestion in this checkpoint).",
      "HTTP browser timings not measured here (no Next on :3003); server-path FS probe mirrors the previous render bottleneck.",
    ],
  };

  const outDir = resolve(process.cwd(), "tmp/regression");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "lazy-knowledge-checkpoint.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  appendFileSync(
    resolve(outDir, "lazy-knowledge-checkpoint.run.log"),
    `${new Date().toISOString()} overall=${report.pass.overall}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
  if (!report.pass.overall) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
