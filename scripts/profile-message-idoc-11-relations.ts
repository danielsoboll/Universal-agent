/**
 * Profile MESSAGE_IDOC_11 relations via generic pattern
 *   *_MESSAGE_IDOC_11_RELATIONS.jsonl
 * Exactly one match required. Read-only — no canonical writes.
 *
 * Usage:
 *   npx tsx scripts/profile-message-idoc-11-relations.ts [--project P01]
 */
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import {
  MESSAGE_IDOC_11_RELATIONS_PATTERN,
  resolveMessageIdoc11RelationsFile,
} from "../src/lib/admin/datenbasis/messageIdocConfig/resolveRelations11";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  loadEnvFile();
  const projectKey = argValue("--project") ?? "P01";
  void getLocalDataRoot();

  let selected;
  try {
    selected = resolveMessageIdoc11RelationsFile(projectKey);
  } catch (e) {
    console.error(
      JSON.stringify({
        ok: false,
        pattern: MESSAGE_IDOC_11_RELATIONS_PATTERN,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    process.exit(1);
  }

  const relationTypes: Record<string, number> = {};
  const fromTypes: Record<string, number> = {};
  const toTypes: Record<string, number> = {};
  const partnerType: Record<string, number> = {};
  const direction: Record<string, number> = {};
  const sourceTable: Record<string, number> = {};
  const edgeKeys = new Map<string, number>();
  const fullKeys = new Map<string, number>();
  const lineHashes = new Map<string, number>();

  let lines = 0;
  let empty = 0;
  let parse_errors = 0;
  let relations = 0;
  let header: Record<string, unknown> | null = null;

  const rl = createInterface({
    input: createReadStream(selected.absolutePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines += 1;
    if (!line.trim()) {
      empty += 1;
      continue;
    }
    const lh = createHash("sha1").update(line).digest("hex");
    lineHashes.set(lh, (lineHashes.get(lh) ?? 0) + 1);
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parse_errors += 1;
      continue;
    }
    const rt = String(obj.record_type ?? "");
    if (rt === "header") {
      header = obj;
      continue;
    }
    if (rt !== "relation") continue;
    relations += 1;
    const from_type = String(obj.from_type ?? "");
    const from_name = String(obj.from_name ?? "");
    const relation_type = String(obj.relation_type ?? "");
    const to_type = String(obj.to_type ?? "");
    const to_name = String(obj.to_name ?? "");
    const metadata = String(obj.metadata ?? "");
    relationTypes[relation_type] = (relationTypes[relation_type] ?? 0) + 1;
    fromTypes[from_type] = (fromTypes[from_type] ?? 0) + 1;
    toTypes[to_type] = (toTypes[to_type] ?? 0) + 1;

    const edge = [from_type, from_name, relation_type, to_type, to_name].join(
      "\u0001",
    );
    edgeKeys.set(edge, (edgeKeys.get(edge) ?? 0) + 1);
    const full = `${edge}\u0001${metadata}`;
    fullKeys.set(full, (fullKeys.get(full) ?? 0) + 1);

    for (const part of metadata.split(";")) {
      const p = part.trim();
      if (!p.includes("=")) continue;
      const [k, v] = p.split("=", 2);
      if (k === "partner_type") {
        partnerType[v!] = (partnerType[v!] ?? 0) + 1;
      } else if (k === "direction") {
        direction[v!] = (direction[v!] ?? 0) + 1;
      } else if (k === "source") {
        sourceTable[v!] = (sourceTable[v!] ?? 0) + 1;
      }
    }
  }
  rl.close();

  const lineDupExtra = [...lineHashes.values()].reduce(
    (a, c) => a + (c > 1 ? c - 1 : 0),
    0,
  );
  const edgeDupExtra = [...edgeKeys.values()].reduce(
    (a, c) => a + (c > 1 ? c - 1 : 0),
    0,
  );
  const fullDupExtra = [...fullKeys.values()].reduce(
    (a, c) => a + (c > 1 ? c - 1 : 0),
    0,
  );

  console.log(
    JSON.stringify(
      {
        ok: parse_errors === 0,
        detection: {
          pattern: MESSAGE_IDOC_11_RELATIONS_PATTERN,
          fileName: selected.fileName,
          relativePath: `raw/${selected.relativePath}`,
          bytes: selected.bytes,
          matches: 1,
        },
        header,
        lines,
        empty,
        parse_errors,
        relations,
        relation_types: relationTypes,
        from_types: fromTypes,
        to_types: toTypes,
        unique_edge_keys: edgeKeys.size,
        unique_full_keys: fullKeys.size,
        exact_line_duplicates_extra: lineDupExtra,
        exact_line_duplicate_rate:
          lines > 0 ? Number((lineDupExtra / lines).toFixed(6)) : 0,
        edge_duplicates_extra: edgeDupExtra,
        edge_duplicate_rate:
          relations > 0 ? Number((edgeDupExtra / relations).toFixed(6)) : 0,
        partner_contexts: {
          partner_type: partnerType,
          direction,
          source_table: sourceTable,
          partner_profile_from_count: fromTypes.PARTNER_PROFILE ?? 0,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
