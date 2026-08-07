/**
 * Deterministic overlay: map existing class unit analyses → unified relation edges.
 * No OpenAI. Does not modify analyses or RAW. Writes canonical/relations/class_analysis_links.jsonl.
 *
 * Usage: npx tsx scripts/migrate-class-analysis-relations.ts --project P01
 */
import { createHash } from "crypto";
import { createWriteStream, existsSync } from "fs";
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "../src/lib/localData/fs";
import { resolveProjectZonePath } from "../src/lib/localData/paths";
import { streamJsonlObjects, asString } from "../src/lib/knowledge/multiSourceSearch/streamJsonl";

type OutRel = {
  relation_type: string;
  from_object: string;
  to_object: string;
  from_type: string;
  to_type: string;
  source: string;
  attributes?: Record<string, unknown>;
  _canonical_key: string;
};

function key(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

function parseArgs(argv: string[]) {
  let project = "P01";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) project = argv[++i]!;
  }
  return { project };
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const { project } = parseArgs(process.argv.slice(2));

  const analyses = resolveProjectZonePath(
    project,
    "analyses",
    "classes",
    "unit_analyses.jsonl",
  );
  if (!existsSync(analyses)) {
    console.error("missing", analyses);
    process.exit(1);
  }

  ensureWritableDir(project, "canonical", "relations");
  const outRel = "relations/class_analysis_links.jsonl";
  const absOut = resolveProjectZonePath(project, "canonical", outRel);
  const ws = createWriteStream(absOut, { flags: "w" });

  let units = 0;
  let edges = 0;
  const seen = new Set<string>();

  const writeRel = (r: Omit<OutRel, "_canonical_key">) => {
    const _canonical_key = key([
      r.relation_type,
      r.from_object,
      r.to_object,
    ]);
    if (seen.has(_canonical_key)) return;
    seen.add(_canonical_key);
    const row: OutRel = { ...r, _canonical_key };
    ws.write(`${JSON.stringify(row)}\n`);
    edges += 1;
  };

  for await (const rec of streamJsonlObjects(analyses)) {
    units += 1;
    const className = asString(rec.class_name);
    const methodName = asString(rec.method_name);
    if (!className || !methodName) continue;
    const methodId = `${className}.${methodName}`;

    writeRel({
      relation_type: "CLASS_CONTAINS_METHOD",
      from_object: className,
      to_object: methodId,
      from_type: "CLASS",
      to_type: "METHOD",
      source: "analyses/classes/unit_analyses.jsonl",
    });

    const calledFns = Array.isArray(rec.called_functions)
      ? rec.called_functions
      : [];
    for (const fn of calledFns) {
      const name = typeof fn === "string" ? fn : asString((fn as { name?: string })?.name);
      if (!name) continue;
      writeRel({
        relation_type: "CALLS_FUNCTION",
        from_object: methodId,
        to_object: name,
        from_type: "METHOD",
        to_type: "FUNCTION_MODULE",
        source: "analyses/classes/unit_analyses.jsonl",
      });
    }

    const calledMethods = [
      ...(Array.isArray(rec.called_methods) ? rec.called_methods : []),
      ...(Array.isArray(rec.called_method_refs) ? rec.called_method_refs : []),
    ];
    for (const m of calledMethods) {
      const name =
        typeof m === "string"
          ? m
          : asString((m as { name?: string; method?: string })?.name) ||
            asString((m as { method?: string })?.method);
      if (!name) continue;
      writeRel({
        relation_type: "CALLS_METHOD",
        from_object: methodId,
        to_object: name,
        from_type: "METHOD",
        to_type: "METHOD",
        source: "analyses/classes/unit_analyses.jsonl",
      });
    }

    for (const [field, rel] of [
      ["tables_read", "READS_TABLE"],
      ["tables_written", "WRITES_TABLE"],
    ] as const) {
      const arr = Array.isArray(rec[field]) ? rec[field] : [];
      for (const t of arr) {
        const name = typeof t === "string" ? t : asString((t as { name?: string })?.name);
        if (!name) continue;
        writeRel({
          relation_type: rel,
          from_object: methodId,
          to_object: name,
          from_type: "METHOD",
          to_type: "TABLE",
          source: "analyses/classes/unit_analyses.jsonl",
        });
      }
    }

    const values = [
      ...(Array.isArray(rec.hardcoded_values) ? rec.hardcoded_values : []),
      ...(Array.isArray(rec.conditions) ? rec.conditions : []),
    ];
    for (const v of values) {
      const text =
        typeof v === "string"
          ? v
          : asString((v as { value?: string })?.value) ||
            asString((v as { text?: string })?.text);
      if (!text || text.length < 2 || text.length > 40) continue;
      // Only keep technical-looking literals
      if (!/^[A-Z0-9_/\-]{2,}$/i.test(text.trim())) continue;
      writeRel({
        relation_type: "CODE_CHECKS_VALUE",
        from_object: methodId,
        to_object: text.trim(),
        from_type: "METHOD",
        to_type: "TECHNICAL_SYMBOL",
        source: "analyses/classes/unit_analyses.jsonl",
        attributes: { raw: text.trim() },
      });
    }
  }

  await new Promise<void>((resolveDone, reject) => {
    ws.end(() => resolveDone());
    ws.on("error", reject);
  });

  writeGeneratedText(
    project,
    "logs",
    "relations/class-analysis-links-report.json",
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        units_scanned: units,
        edges_written: edges,
        output: `canonical/${outRel}`,
        openai: false,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    JSON.stringify(
      { ok: true, units, edges, output: `canonical/${outRel}` },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
