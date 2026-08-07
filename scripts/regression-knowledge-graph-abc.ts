/**
 * Regression A/B/C against canonical/knowledge-graph (no OpenAI / index).
 *
 *   npx tsx scripts/regression-knowledge-graph-abc.ts [--project P01]
 */
import { createReadStream, existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { resolveWritablePath } from "../src/lib/localData/paths";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

type Node = Record<string, unknown>;
type Edge = Record<string, unknown>;

async function* streamJsonl(abs: string): AsyncGenerator<Record<string, unknown>> {
  if (!existsSync(abs)) return;
  const rl = createInterface({
    input: createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as unknown;
        if (o && typeof o === "object" && !Array.isArray(o)) {
          yield o as Record<string, unknown>;
        }
      } catch {
        /* skip */
      }
    }
  } finally {
    rl.close();
  }
}

function hit(o: unknown, needle: string): boolean {
  return JSON.stringify(o).toUpperCase().includes(needle.toUpperCase());
}

async function main() {
  loadEnvFile();
  const projectKey = argValue("--project") ?? "P01";
  void getLocalDataRoot();

  const nodesPath = resolveWritablePath(
    projectKey,
    "canonical",
    "knowledge-graph",
    "nodes.jsonl",
  );
  const edgesPath = resolveWritablePath(
    projectKey,
    "canonical",
    "knowledge-graph",
    "edges.jsonl",
  );
  const unresolvedPath = resolveWritablePath(
    projectKey,
    "canonical",
    "knowledge-graph",
    "unresolved.jsonl",
  );
  const manifestPath = resolveWritablePath(
    projectKey,
    "canonical",
    "knowledge-graph",
    "manifest.json",
  );

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const unresolved: Edge[] = [];
  const byId = new Map<string, Node>();

  for await (const n of streamJsonl(nodesPath)) {
    nodes.push(n);
    byId.set(String(n.node_id), n);
  }
  for await (const e of streamJsonl(edgesPath)) edges.push(e);
  for await (const e of streamJsonl(unresolvedPath)) unresolved.push(e);

  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : null;

  const neighbors = (nodeId: string, bag: Edge[]) =>
    bag.filter(
      (e) =>
        e.from_node_id === nodeId ||
        e.to_node_id === nodeId ||
        hit(e.from_node_id, nodeId) ||
        hit(e.to_node_id, nodeId),
    );

  // ---------- A ZECD ----------
  const zecdNodes = nodes.filter((n) => hit(n, "ZECD"));
  const zecdOutput = zecdNodes.filter(
    (n) =>
      n.object_type === "OUTPUT_TYPE" &&
      (n.evidence as { authoritative_existence?: boolean } | undefined)
        ?.authoritative_existence === true,
  );
  const zecdText = zecdNodes.filter((n) => {
    if (n.object_type !== "OUTPUT_TYPE_TEXT") return false;
    const attrs = (n.attributes as Record<string, unknown>) ?? {};
    const blob = `${n.display_names ?? ""} ${attrs.VTEXT ?? ""} ${attrs.display_name ?? ""} ${JSON.stringify(n)}`;
    return /Lieferr[uü]ckmeldung/i.test(blob) || hit(blob, "ZECD");
  });
  const textEdges = edges.filter(
    (e) =>
      e.relation_type === "OUTPUT_TYPE_HAS_TEXT" && hit(e, "ZECD"),
  );
  const zecdEdges = [
    ...edges.filter((e) => hit(e, "ZECD")),
    ...unresolved.filter((e) => hit(e, "ZECD")),
  ];

  const pathsA: Array<Record<string, unknown>> = [];
  for (const e of zecdEdges) {
    const from = byId.get(String(e.from_node_id));
    const to = byId.get(String(e.to_node_id));
    pathsA.push({
      from: e.from_node_id,
      from_type: from?.object_type ?? null,
      relation: e.relation_type,
      to: e.to_node_id,
      to_type: to?.object_type ?? null,
      evidence_class: e.evidence_class,
      authoritative: e.authoritative,
      occurrence_count: e.occurrence_count,
      source_files: e.source_files,
      source_tables: e.source_tables,
      resolution: e.resolution,
      contexts_sample: Array.isArray(e.contexts)
        ? (e.contexts as string[]).slice(0, 3)
        : [],
    });
  }

  const idocPartnerA = pathsA.filter((p) => {
    const rel = String(p.relation);
    const ft = String(p.from_type);
    const tt = String(p.to_type);
    return (
      rel.includes("IDOC") ||
      rel.includes("MESSAGE") ||
      rel.includes("PARTNER") ||
      ft.includes("IDOC") ||
      ft.includes("MESSAGE") ||
      ft.includes("PARTNER") ||
      tt.includes("IDOC") ||
      tt.includes("MESSAGE") ||
      tt.includes("PARTNER")
    );
  });

  const A = {
    authoritative_output_type_nodes: zecdOutput.map((n) => ({
      node_id: n.node_id,
      identity_key: n.identity_key,
      name: n.name,
      evidence: n.evidence,
      sources: n.sources,
      display_names: n.display_names,
    })),
    text_nodes: zecdText.map((n) => ({
      node_id: n.node_id,
      identity_key: n.identity_key,
      display_names: n.display_names,
      VTEXT: (n.attributes as Record<string, unknown>)?.VTEXT ?? null,
      display_name: (n.attributes as Record<string, unknown>)?.display_name ?? null,
      evidence: n.evidence,
    })),
    text_edges: textEdges.slice(0, 10),
    text_lieferrueckmeldung: zecdText.some((n) => {
      const attrs = (n.attributes as Record<string, unknown>) ?? {};
      return /Lieferr[uü]ckmeldung/i.test(
        `${attrs.VTEXT ?? ""} ${attrs.display_name ?? ""} ${JSON.stringify(n.display_names ?? [])}`,
      );
    }),
    program_edges: pathsA.filter(
      (p) =>
        String(p.relation).includes("PROGRAM") ||
        p.to_type === "PROGRAM" ||
        String(p.relation) === "OUTPUT_TYPE_TO_PROGRAM" ||
        String(p.relation) === "PROCESSED_BY_PROGRAM",
    ),
    routine_edges: pathsA.filter(
      (p) =>
        String(p.relation).includes("ROUTINE") ||
        p.to_type === "FORM_ROUTINE" ||
        String(p.relation) === "PROCESSED_BY_ROUTINE" ||
        String(p.relation) === "OUTPUT_TYPE_TO_ROUTINE",
    ),
    repository_code_units: pathsA.filter(
      (p) =>
        String(p.evidence_class) === "code_usage" ||
        String(p.evidence_class) === "unresolved" ||
        String(p.source_files).includes("repository-relations"),
    ),
    idoc_partner_only_if_present: idocPartnerA,
    full_paths_with_evidence: pathsA.slice(0, 80),
  };

  // ---------- B ZRAH ----------
  const zrahNodes = nodes.filter((n) => hit(n, "ZRAH"));
  const zrahAsOutputAuth = zrahNodes.filter(
    (n) =>
      n.object_type === "OUTPUT_TYPE" &&
      (n.evidence as { authoritative_existence?: boolean })
        ?.authoritative_existence === true,
  );
  const zrahAsOutputAny = zrahNodes.filter((n) => n.object_type === "OUTPUT_TYPE");
  const rvadin = nodes.filter(
    (n) =>
      hit(n.node_id, "Z_RVADIN01") ||
      hit(n.name, "Z_RVADIN01") ||
      hit(n.identity_key, "Z_RVADIN01"),
  );
  const getZrah = nodes.filter(
    (n) =>
      hit(n.name, "GET_ZRAH_PRICE") || hit(n.node_id, "GET_ZRAH_PRICE"),
  );
  const zrahEdges = [
    ...edges.filter(
      (e) =>
        hit(e, "ZRAH") ||
        hit(e, "Z_RVADIN01") ||
        hit(e, "GET_ZRAH_PRICE"),
    ),
    ...unresolved.filter(
      (e) =>
        hit(e, "ZRAH") ||
        hit(e, "Z_RVADIN01") ||
        hit(e, "GET_ZRAH_PRICE"),
    ),
  ];

  const codePathB = zrahEdges
    .filter(
      (e) =>
        hit(e, "Z_RVADIN01") &&
        (hit(e, "GET_ZRAH_PRICE") || hit(e, "ZRAH")),
    )
    .map((e) => ({
      from: e.from_node_id,
      relation: e.relation_type,
      to: e.to_node_id,
      evidence_class: e.evidence_class,
      source_files: e.source_files,
      occurrence_count: e.occurrence_count,
    }));

  // Pricing config domain absent in this graph's sources
  const pricingConfigPresent = nodes.some(
    (n) =>
      (n.object_type === "CONDITION_TYPE" ||
        n.object_type === "PRICING_CONDITION_TYPE") &&
      hit(n, "ZRAH"),
  );

  const B = {
    safe_object_types: [...new Set(zrahNodes.map((n) => String(n.object_type)))],
    nodes_sample: zrahNodes.slice(0, 30).map((n) => ({
      node_id: n.node_id,
      object_type: n.object_type,
      evidence: n.evidence,
    })),
    z_rvadin01_nodes: rvadin.map((n) => ({
      node_id: n.node_id,
      object_type: n.object_type,
      evidence: n.evidence,
    })),
    get_zrah_price_nodes: getZrah.map((n) => ({
      node_id: n.node_id,
      object_type: n.object_type,
    })),
    code_path: codePathB.slice(0, 40),
    no_authoritative_output_type: zrahAsOutputAuth.length === 0,
    output_type_nodes_any: zrahAsOutputAny,
    pricing_configuration: {
      present_in_graph: pricingConfigPresent,
      missing: !pricingConfigPresent,
      note: !pricingConfigPresent
        ? "Pricing-Konfiguration fehlt als Datenbereich im Knowledge Graph (keine CONDITION_TYPE/PRICING-Quelle in den Graph-Inputs)"
        : "Pricing-Knoten vorhanden",
    },
  };

  // ---------- C ZZ_VLAGER ----------
  const vlagerNodes = nodes.filter(
    (n) =>
      hit(n, "ZZ_VLAGER") ||
      hit(n, "KNVV-ZZ_VLAGER") ||
      hit(n, "VLAGER") ||
      hit(n, "ZZTVAG") ||
      hit(n, "ZVLAGER"),
  );
  const vlagerEdges = [
    ...edges.filter(
      (e) =>
        hit(e, "ZZ_VLAGER") ||
        hit(e, "VLAGER") ||
        hit(e, "ZZTVAG") ||
        hit(e, "ZVLAGER"),
    ),
    ...unresolved.filter(
      (e) =>
        hit(e, "ZZ_VLAGER") ||
        hit(e, "VLAGER") ||
        hit(e, "ZZTVAG") ||
        hit(e, "ZVLAGER"),
    ),
  ];

  const reads = vlagerEdges.filter(
    (e) =>
      e.relation_type === "READS_TABLE" ||
      e.relation_unified === "CODE_READS_TABLE",
  );
  const writes = vlagerEdges.filter(
    (e) =>
      e.relation_type === "WRITES_TABLE" ||
      e.relation_unified === "CODE_WRITES_TABLE",
  );
  const classMethod = vlagerEdges.filter((e) => {
    const from = byId.get(String(e.from_node_id));
    return (
      from?.object_type === "CLASS" ||
      from?.object_type === "METHOD" ||
      from?.object_type === "CLASS_INCLUDE" ||
      String(e.from_node_id).includes("CLASS") ||
      String(e.from_node_id).includes("METHOD")
    );
  });
  const controlTables = vlagerEdges.filter((e) => {
    const to = byId.get(String(e.to_node_id));
    return (
      to?.object_type === "TABLE" ||
      hit(e.to_node_id, "ZZTVAG") ||
      hit(e.to_node_id, "ZVLAGER") ||
      hit(e.to_node_id, "TABLE")
    );
  });

  const ddicFieldNodes = vlagerNodes.filter(
    (n) =>
      n.object_type === "FIELD" ||
      n.object_type === "MASTER_DATA_FIELD" ||
      hit(n.node_id, "KNVV-ZZ_VLAGER"),
  );

  const C = {
    code_usages: vlagerEdges
      .filter(
        (e) =>
          e.evidence_class === "code_usage" ||
          e.evidence_class === "unresolved",
      )
      .slice(0, 40)
      .map((e) => ({
        from: e.from_node_id,
        relation: e.relation_type,
        to: e.to_node_id,
        source_files: e.source_files,
        occurrence_count: e.occurrence_count,
      })),
    reading_units: reads.slice(0, 30).map((e) => ({
      from: e.from_node_id,
      to: e.to_node_id,
      occurrence_count: e.occurrence_count,
      source_files: e.source_files,
    })),
    writing_units: writes.slice(0, 30).map((e) => ({
      from: e.from_node_id,
      to: e.to_node_id,
      occurrence_count: e.occurrence_count,
      source_files: e.source_files,
    })),
    class_method_paths: classMethod.slice(0, 30).map((e) => ({
      from: e.from_node_id,
      relation: e.relation_type,
      to: e.to_node_id,
      evidence_class: e.evidence_class,
    })),
    control_tables: controlTables.slice(0, 30).map((e) => ({
      from: e.from_node_id,
      relation: e.relation_type,
      to: e.to_node_id,
      source_files: e.source_files,
    })),
    ddic_type_text_evidence: {
      // Until SAP DDIC re-export is ingested into the knowledge graph sources,
      // mark missing even if master-data structure exists outside the graph.
      present_in_graph: false,
      missing: true,
      note:
        "DDIC-Typ-/Textbeleg für KNVV-ZZ_VLAGER fehlt im Knowledge Graph bis zum SAP-DDIC-Rückexport — nicht durch ZZTVAG oder Symbolähnlichkeit ersetzbar",
      not_substituted_by_zztvag: true,
      nodes: [],
    },
  };

  const failures: string[] = [];
  if (A.authoritative_output_type_nodes.length === 0) {
    failures.push("A: kein autoritativer OUTPUT_TYPE ZECD");
  }
  if (!A.text_lieferrueckmeldung) {
    failures.push('A: Text „Lieferrückmeldung“ fehlt');
  }
  if (A.program_edges.length === 0) failures.push("A: kein Programm-Pfad");
  if (A.routine_edges.length === 0) failures.push("A: kein Routine-Pfad");
  if (!B.no_authoritative_output_type) {
    failures.push("B: autoritativer OUTPUT_TYPE ZRAH existiert (darf nicht)");
  }
  if (B.z_rvadin01_nodes.length === 0) {
    failures.push("B: Z_RVADIN01 fehlt");
  }
  if (B.get_zrah_price_nodes.length === 0 && B.code_path.length === 0) {
    failures.push("B: GET_ZRAH_PRICE Pfad fehlt");
  }
  if (!B.pricing_configuration.missing) {
    // ok if present; no failure
  }
  if (C.code_usages.length === 0 && C.control_tables.length === 0) {
    failures.push("C: keine VLAGER/ZZTVAG Graph-Treffer");
  }
  if (!C.ddic_type_text_evidence.missing) {
    // If somehow present, fine
  }

  // Quality summary from manifest
  const quality = {
    nodes_by_type: manifest?.stats?.nodes_by_type ?? null,
    edges_by_relation_top: manifest?.stats?.edges_by_relation
      ? Object.entries(manifest.stats.edges_by_relation as Record<string, number>)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
      : null,
    edges_dup_merged: manifest?.stats?.edges_dup_merged ?? null,
    unresolved_unique: manifest?.stats?.edges_unresolved_unique ?? null,
    type_conflicts: manifest?.stats?.type_conflicts ?? null,
    name_collisions_not_merged:
      manifest?.stats?.name_collisions_not_merged ?? null,
    name_collision_samples:
      manifest?.stats?.name_collision_samples ?? null,
  };

  const report = {
    ok: failures.length === 0,
    failures,
    quality,
    A_ZECD: A,
    B_ZRAH: B,
    C_ZZ_VLAGER: C,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
