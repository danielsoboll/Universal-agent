import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { convertRepositoryRelationsPass1 } from "../../src/lib/ingest/repositoryRelationsCanonical";
import { resolveExactlyOneRawFile } from "../../src/lib/localData/resolveExactlyOneRawFile";
import {
  MESSAGE_IDOC_11_RELATIONS_PATTERN,
  isMessageIdoc11RelationsFileName,
} from "../../src/lib/admin/datenbasis/messageIdocConfig/resolveRelations11";

async function main() {
  assert.equal(
    isMessageIdoc11RelationsFileName(
      "Q01_20260806_224048_MESSAGE_IDOC_11_RELATIONS.jsonl",
    ),
    true,
  );
  assert.equal(
    isMessageIdoc11RelationsFileName(
      "MESSAGE_IDOC_11_RELATIONS.jsonl",
    ),
    true,
  );
  assert.equal(
    isMessageIdoc11RelationsFileName(
      "Q01_MESSAGE_IDOC_10_ALE_ROUTING_CONTENT.jsonl",
    ),
    false,
  );
  assert.ok(MESSAGE_IDOC_11_RELATIONS_PATTERN.includes("MESSAGE_IDOC_11"));

  const root = mkdtempSync(path.join(tmpdir(), "repo-rel-"));
  const prev = process.env.LOCAL_DATA_ROOT;
  process.env.LOCAL_DATA_ROOT = root;
  const project = "T01";
  try {
    const rawDir = path.join(root, project, "raw", "repository-relations");
    mkdirSync(rawDir, { recursive: true });
    const fileName =
      "Q01_20260101_120000_SAP_REPOSITORY_RELATIONS_CONTENT.jsonl";
    writeFileSync(
      path.join(rawDir, fileName),
      [
        JSON.stringify({
          schema_version: "3.1",
          record_type: "header",
          system_id: "Q01",
          export_type: "SAP_REPOSITORY_RELATIONS",
          object_count: 1,
          relation_count: 3,
        }),
        JSON.stringify({
          schema_version: "3.1",
          record_type: "source_object",
          system_id: "Q01",
          source_key: "Q01|PROGRAM|ZDEMO",
          object_type: "PROGRAM",
          object_name: "ZDEMO",
          description: "Demo",
          main_program: "",
          active: true,
        }),
        JSON.stringify({
          schema_version: "3.1",
          record_type: "relation",
          system_id: "Q01",
          from_type: "PROGRAM",
          from_name: "ZDEMO",
          relation_type: "INCLUDES",
          to_type: "INCLUDE",
          to_name: "ZDEMOTOP",
          metadata: "ctx-a",
        }),
        JSON.stringify({
          schema_version: "3.1",
          record_type: "relation",
          system_id: "Q01",
          from_type: "PROGRAM",
          from_name: "ZDEMO",
          relation_type: "INCLUDES",
          to_type: "INCLUDE",
          to_name: "ZDEMOTOP",
          metadata: "ctx-b",
        }),
        JSON.stringify({
          schema_version: "3.1",
          record_type: "relation",
          system_id: "Q01",
          from_type: "PROGRAM",
          from_name: "ZDEMO",
          relation_type: "UNRESOLVED_INSTANCE_METHOD_CALL",
          to_type: "METHOD_SYMBOL",
          to_name: "lo->run(",
          metadata: "ZDEMO",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const one = resolveExactlyOneRawFile(
      project,
      ["repository-relations"],
      "*_SAP_REPOSITORY_RELATIONS_CONTENT.jsonl",
    );
    assert.equal(one.fileName, fileName);

    let threw = false;
    writeFileSync(
      path.join(rawDir, "Q01_OTHER_SAP_REPOSITORY_RELATIONS_CONTENT.jsonl"),
      "{}\n",
    );
    try {
      resolveExactlyOneRawFile(
        project,
        ["repository-relations"],
        "*_SAP_REPOSITORY_RELATIONS_CONTENT.jsonl",
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    rmSync(
      path.join(rawDir, "Q01_OTHER_SAP_REPOSITORY_RELATIONS_CONTENT.jsonl"),
    );

    const canon = path.join(root, project, "canonical", "repository-relations");
    mkdirSync(canon, { recursive: true });
    const result = await convertRepositoryRelationsPass1({
      absoluteRawPath: one.absolutePath,
      absoluteCanonicalDir: canon,
      sourceFileName: one.fileName,
      sourceRelativePath: `raw/${one.relativePath}`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.manifest.stats.source_objects_unique, 1);
    assert.equal(result.manifest.stats.relations_unique, 1);
    assert.equal(result.manifest.stats.relations_raw, 2);
    assert.equal(result.manifest.stats.unresolved_unique, 1);

    const relLine = readFileSync(path.join(canon, "relations.jsonl"), "utf8")
      .trim()
      .split("\n")[0]!;
    const rel = JSON.parse(relLine) as {
      occurrence_count: number;
      contexts: string[];
    };
    assert.equal(rel.occurrence_count, 2);
    assert.deepEqual(rel.contexts, ["ctx-a", "ctx-b"]);

    assert.ok(existsSync(path.join(canon, "unresolved.jsonl")));
    assert.ok(existsSync(path.join(canon, "manifest.json")));

    const again = await convertRepositoryRelationsPass1({
      absoluteRawPath: one.absolutePath,
      absoluteCanonicalDir: canon,
      sourceFileName: one.fileName,
      sourceRelativePath: `raw/${one.relativePath}`,
    });
    assert.equal(again.ok, false);
    assert.ok(
      again.errors.some((e) => e.includes("Write-once")),
      "second convert must refuse overwrite",
    );

    console.log("ok repositoryRelations + messageIdoc11 detection");
  } finally {
    if (prev === undefined) delete process.env.LOCAL_DATA_ROOT;
    else process.env.LOCAL_DATA_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
