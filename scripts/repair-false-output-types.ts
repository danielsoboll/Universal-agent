/**
 * Atomic repair: remove false OUTPUT_TYPE nodes from T685 KVEWE≠B.
 *
 *   npx tsx scripts/repair-false-output-types.ts --project P01
 *
 * Does not touch class analysis. Does not delete valid KVEWE=B output types.
 */
import { resolve } from "path";
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  copyFileSync,
} from "fs";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { BOUND_DATA_PROJECT_KEY } from "../src/lib/localData/boundProject";
import { messageIdocObjectIsAuthoritativeOutputType } from "../src/lib/domain/typeAuthority";

loadEnvFile(resolve(process.cwd(), ".env.local"));
getLocalDataRoot();

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function atomicRewriteJsonl(
  path: string,
  keep: (obj: Record<string, unknown>) => boolean,
): { kept: number; removed: number; removedSample: unknown[] } {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const out: string[] = [];
  let kept = 0;
  let removed = 0;
  const removedSample: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push(line);
      continue;
    }
    if (keep(obj)) {
      out.push(JSON.stringify(obj));
      kept += 1;
    } else {
      removed += 1;
      if (removedSample.length < 8) removedSample.push(obj);
    }
  }
  const tmp = `${path}.tmp.${Date.now()}`;
  const bak = `${path}.bak.${Date.now()}`;
  copyFileSync(path, bak);
  writeFileSync(tmp, out.map((l) => l + "\n").join(""), "utf8");
  renameSync(tmp, path);
  return { kept, removed, removedSample };
}

async function main() {
  const project =
    argValue(process.argv.slice(2), "--project")?.trim() ||
    BOUND_DATA_PROJECT_KEY;
  const root = resolve(getLocalDataRoot(), project);

  const objectsPath = resolve(
    root,
    "canonical/message-idoc-config/objects.jsonl",
  );
  const idsPath = resolve(
    root,
    "canonical/message-idoc-config/object_ids.jsonl",
  );
  const docsPath = resolve(root, "indexes/search/search_documents.jsonl");

  if (!existsSync(objectsPath)) {
    throw new Error(`Fehlt: ${objectsPath}`);
  }

  const dropKeys = new Set<string>();
  const dropIds = new Set<string>();

  const shouldKeepObject = (obj: Record<string, unknown>): boolean => {
    const ot = String(obj.object_type ?? "");
    if (ot !== "output_type" && ot !== "output_type_text") return true;
    const attrs =
      obj.attributes && typeof obj.attributes === "object"
        ? (obj.attributes as Record<string, unknown>)
        : {};
    // object_ids.jsonl may only have top-level fields — check KVEWE on object_id prefix
    const objectId = String(obj.object_id ?? "");
    const kveweFromId = objectId.split("|")[0] ?? "";
    const attrsWithKvewe = {
      ...attrs,
      KVEWE: attrs.KVEWE ?? kveweFromId,
    };
    const ok = messageIdocObjectIsAuthoritativeOutputType({
      object_type: ot,
      attributes: attrsWithKvewe,
    });
    if (!ok) {
      if (typeof obj._canonical_key === "string") dropKeys.add(obj._canonical_key);
      if (objectId) dropIds.add(objectId);
    }
    return ok;
  };

  console.log("Repairing", objectsPath);
  const r1 = atomicRewriteJsonl(objectsPath, shouldKeepObject);
  console.log("objects kept/removed", r1.kept, r1.removed);
  console.log(
    "sample removed",
    JSON.stringify(r1.removedSample.slice(0, 3), null, 2),
  );

  if (existsSync(idsPath)) {
    console.log("Repairing", idsPath);
    const r2 = atomicRewriteJsonl(idsPath, shouldKeepObject);
    console.log("object_ids kept/removed", r2.kept, r2.removed);
  }

  // Drop relations that reference removed output_type ids as from/to
  const relPath = resolve(
    root,
    "canonical/message-idoc-config/relations.jsonl",
  );
  if (existsSync(relPath) && dropIds.size > 0) {
    console.log("Repairing", relPath);
    const r3 = atomicRewriteJsonl(relPath, (obj) => {
      const fromType = String(obj.from_object_type ?? "");
      const toType = String(obj.to_object_type ?? "");
      const fromId = String(obj.from_object_id ?? "");
      const toId = String(obj.to_object_id ?? "");
      if (
        (fromType === "output_type" || fromType === "output_type_text") &&
        dropIds.has(fromId)
      ) {
        return false;
      }
      if (
        (toType === "output_type" || toType === "output_type_text") &&
        dropIds.has(toId)
      ) {
        return false;
      }
      return true;
    });
    console.log("relations kept/removed", r3.kept, r3.removed);
  }

  if (existsSync(docsPath) && dropKeys.size > 0) {
    console.log("Repairing hybrid search_documents for dropped keys", dropKeys.size);
    const r4 = atomicRewriteJsonl(docsPath, (obj) => {
      const key = String(obj.source_key ?? "");
      if (dropKeys.has(key)) return false;
      // also drop by title pattern for safety
      const title = String(obj.title ?? "");
      const kut = String(obj.knowledge_unit_type ?? "");
      if (
        kut === "message_idoc_object" &&
        (title.startsWith("output_type: ") || title.startsWith("output_type_text: "))
      ) {
        const name = title.split(": ").slice(1).join(": ").trim();
        // Only drop if we know the object_id was removed — check object_name
        const on = String(obj.object_name ?? "");
        if (dropIds.has(on)) return false;
        void name;
      }
      return true;
    });
    console.log("search_documents kept/removed", r4.kept, r4.removed);
  }

  // Verify ZRAH / ZECD
  let zrah = false;
  let zecd = false;
  for (const line of readFileSync(objectsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.object_type === "output_type" && String(o.object_id).includes("ZRAH")) {
      zrah = true;
    }
    if (o.object_type === "output_type" && String(o.object_id).includes("ZECD")) {
      zecd = true;
    }
  }
  console.log(
    JSON.stringify(
      {
        ZRAH_still_output_type: zrah,
        ZECD_still_output_type: zecd,
        dropped_canonical_keys: [...dropKeys].slice(0, 20),
        dropped_ids_sample: [...dropIds].slice(0, 20),
        dropped_id_count: dropIds.size,
      },
      null,
      2,
    ),
  );
  if (zrah) throw new Error("ZRAH still present as output_type");
  if (!zecd) throw new Error("ZECD missing as output_type after repair");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
