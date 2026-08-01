/**
 * Transactional prepare-then-swap rebuild from current raw SSOT.
 *
 *   npm run rebuild-data -- --project P01 --type control-tables
 *   npm run rebuild-data -- --project P01 --type all
 */
import { loadCustomerConfig, resolveSystemId } from "../src/lib/core/customerConfig";
import { LocalDataError } from "../src/lib/localData/errors";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { writeGeneratedText } from "../src/lib/localData/fs";
import { rebuildData, parseRebuildType } from "../src/lib/rebuild/rebuildData";
import { REBUILD_STATUS_LABELS_DE } from "../src/lib/rebuild/types";
import { loadEnvLocal } from "../src/lib/search/cliCustomerArgs";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let project: string | undefined;
  let type: string | undefined;
  let customer: string | undefined;
  let system: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--project") project = argv[++i];
    else if (a === "--type") type = argv[++i];
    else if (a === "--customer") customer = argv[++i];
    else if (a === "--system") system = argv[++i];
  }
  return { project, type, customer, system };
}

function printTypeReport(r: {
  type: string;
  source_files: string[];
  source_sizes?: number[];
  source_sha256?: string[];
  lines_read: number;
  structural_validation_ok?: boolean;
  error_count: number;
  canonical_records: number;
  search_documents: number;
  embeddings: number;
  index_entries: number;
  old_deleted?: boolean;
  success?: boolean;
  smoke_ok: boolean;
  derived_replaced: boolean;
  no_new_folder_structure: boolean;
  smoke: Array<{ name: string; ok: boolean; detail: string }>;
  duration_ms: number;
  error?: string | null;
}) {
  console.log("\n=== REBUILD REPORT ===");
  console.log(`Typ: ${r.type}`);
  console.log(`Quelldateien: ${r.source_files.join(", ") || "(keine)"}`);
  if (r.source_sizes?.length) {
    console.log(`Dateigrößen: ${r.source_sizes.join(", ")}`);
  }
  if (r.source_sha256?.length) {
    console.log(`SHA-256: ${r.source_sha256.join(", ")}`);
  }
  console.log(`Gelesene Zeilen: ${r.lines_read}`);
  console.log(
    `Strukturell valide: ${r.structural_validation_ok ? "ja" : "nein"}`,
  );
  console.log(`Fehler: ${r.error_count}`);
  console.log(`Canonical-Datensätze: ${r.canonical_records}`);
  console.log(`SearchDocuments: ${r.search_documents}`);
  console.log(`Embeddings: ${r.embeddings}`);
  console.log(`Indexeinträge: ${r.index_entries}`);
    console.log(
      `Alte generierte Daten gelöscht: ${(r.old_deleted ?? r.derived_replaced) ? "ja" : "nein"}`,
    );
  console.log(`Erfolg: ${r.success ? "ja" : "nein"}`);
  console.log(`Smoke-Test erfolgreich: ${r.smoke_ok ? "ja" : "nein"}`);
  console.log(
    `Keine neue Ordnerstruktur angelegt: ${r.no_new_folder_structure ? "ja" : "nein"}`,
  );
  console.log(`Dauer ms: ${r.duration_ms}`);
  if (r.error) console.log(`Fehlertext: ${r.error}`);
  if (r.smoke.length) {
    console.log("\n--- Smoke ---");
    for (const s of r.smoke) {
      console.log(`  [${s.ok ? "OK" : "FAIL"}] ${s.name}: ${s.detail}`);
    }
  }
}

async function main() {
  loadEnvLocal();
  try {
    getLocalDataRoot();
  } catch (error) {
    if (error instanceof LocalDataError) fail(error.message);
    throw error;
  }

  const args = parseArgs(process.argv.slice(2));
  const projectKey = (args.project ?? args.customer ?? "").trim();
  if (!projectKey) {
    fail("Pflichtparameter: --project P01 (oder --customer P01)");
  }
  if (!args.type?.trim()) {
    fail(
      "Pflichtparameter: --type control-tables|classes|programs|materials|customers|vendors|all",
    );
  }

  let rebuildType;
  try {
    rebuildType = parseRebuildType(args.type);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  let customerId = projectKey;
  let systemId = args.system?.trim() || "D01";
  try {
    const config = loadCustomerConfig(args.customer?.trim() || projectKey);
    customerId = config.customer_id;
    systemId = resolveSystemId(config, args.system);
  } catch {
    console.warn(
      `Hinweis: customers/${projectKey}.json nicht geladen — verwende customer=${customerId}, system=${systemId}`,
    );
  }

  console.log(
    `Rebuild starten (prepare-then-swap): project=${projectKey} customer=${customerId} system=${systemId} type=${rebuildType}`,
  );

  const report = await rebuildData({
    projectKey,
    customerId,
    systemId,
    type: rebuildType,
    onTypeStep: (type, step, detail) => {
      const label =
        REBUILD_STATUS_LABELS_DE[
          step as keyof typeof REBUILD_STATUS_LABELS_DE
        ] ?? step;
      console.log(`→ [${type}] ${label}${detail ? ` — ${detail}` : ""}`);
    },
  });

  writeGeneratedText(
    projectKey,
    "logs",
    "rebuild-data-report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  for (const r of report.results) {
    printTypeReport(r);
  }

  const failed = report.results.filter(
    (r) => r.type === "control-tables" && (!r.success || !r.smoke_ok),
  );
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
