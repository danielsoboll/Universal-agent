/**
 * Isolated relevance-gate regression asks against local P01 index.
 *   npx tsx scripts/relevance-gate-regression.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

type CaseId = "A" | "B" | "C" | "D" | "E";

const CASES: Array<{
  id: CaseId;
  question: string;
  expect: "answerable" | "insufficient" | "partially_answerable" | "ok_or_answerable";
}> = [
  {
    id: "A",
    question: "Wo wird zwischen Optitool alt und neu unterschieden?",
    expect: "ok_or_answerable",
  },
  {
    id: "B",
    question:
      "Für welche Kunden gibt es spezifische Anpassungen im DESADV-IDoc?",
    expect: "insufficient",
  },
  {
    id: "C",
    question: "Welche Besonderheiten gibt es für Pepsi Cola?",
    expect: "insufficient",
  },
  {
    id: "D",
    question: "Was macht SET_KONZERNFARBE?",
    expect: "ok_or_answerable",
  },
  {
    id: "E",
    question: "Wie hängen Optitool und DESADV zusammen?",
    expect: "partially_answerable",
  },
];

function summarize(result: Awaited<ReturnType<typeof answerQuestion>>) {
  const gate = result.relevance_gate;
  return {
    status: result.status,
    answerability: gate?.answerability ?? null,
    query_concepts: gate?.query_concepts ?? [],
    matched_concepts: gate?.matched_concepts ?? [],
    missing_concepts: gate?.missing_concepts ?? [],
    supporting_source_ids: gate?.supporting_source_ids ?? [],
    contradicting_source_ids: gate?.contradicting_source_ids ?? [],
    similar_but_insufficient_source_ids:
      gate?.similar_but_insufficient_source_ids ?? [],
    reason: gate?.reason ?? null,
    direct_answer: result.direct_answer?.slice(0, 280) ?? null,
    source_titles: result.sources.slice(0, 8).map((s) => s.title),
    source_keys: result.sources.slice(0, 8).map((s) => s.source_key),
  };
}

function checkExpectation(
  expect: (typeof CASES)[number]["expect"],
  result: Awaited<ReturnType<typeof answerQuestion>>,
): { ok: boolean; detail: string } {
  const gate = result.relevance_gate;
  const ab = gate?.answerability;
  if (expect === "insufficient") {
    const ok =
      result.status === "insufficient" && ab === "insufficient";
    // Must not invent DESADV/OT_UPDATE answers
    const ans = (result.direct_answer ?? "").toLowerCase();
    const invented =
      /ot_update_customer|webservice-proxy|für desadv gibt es/i.test(ans) &&
      !/nicht belastbar|keine belastbare|nicht ausreichend/i.test(ans);
    return {
      ok: ok && !invented,
      detail: `status=${result.status} answerability=${ab} invented=${invented}`,
    };
  }
  if (expect === "partially_answerable") {
    const ok = ab === "partially_answerable" && result.status === "ok";
    return {
      ok,
      detail: `status=${result.status} answerability=${ab}`,
    };
  }
  if (expect === "ok_or_answerable") {
    const ok =
      result.status === "ok" &&
      (ab === "answerable" || ab === "partially_answerable");
    return {
      ok,
      detail: `status=${result.status} answerability=${ab}`,
    };
  }
  const ok = ab === expect;
  return { ok, detail: `answerability=${ab}` };
}

function compareOptitoolSnapshot(
  result: Awaited<ReturnType<typeof answerQuestion>>,
): { ok: boolean; notes: string[] } {
  const path = resolve(
    process.cwd(),
    "tmp/regression/optitool-direct-snapshot.json",
  );
  let snap: {
    status?: string;
    process_answer?: { direct_answer?: string };
    compact_technical_details?: { quelle?: string[]; beleg?: string[] };
  };
  try {
    snap = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: true, notes: ["snapshot missing — skipped"] };
  }
  const notes: string[] = [];
  let ok = true;
  if (result.status !== "ok" && snap.status === "ok") {
    ok = false;
    notes.push(`status regress: ${result.status} vs snapshot ${snap.status}`);
  }
  const snapAns = snap.process_answer?.direct_answer ?? "";
  const curAns = result.process_answer?.direct_answer ?? result.direct_answer ?? "";
  // Core claims from snapshot: ZOTCO_IMPORT (alt) and ZCO_IMPORT_NEW3 (neu)
  for (const claim of ["ZOTCO_IMPORT", "ZCO_IMPORT_NEW3", "Optitool"]) {
    if (snapAns.includes(claim) && !curAns.includes(claim)) {
      // Allow claim in technical details / sources instead
      const blob = JSON.stringify({
        ans: curAns,
        tech: result.compact_technical_details,
        sources: result.sources.map((s) => s.title + s.source_key),
      });
      if (!blob.includes(claim)) {
        ok = false;
        notes.push(`missing core claim: ${claim}`);
      } else {
        notes.push(`claim ${claim} present outside direct_answer (ok)`);
      }
    }
  }
  const snapSources = (snap.compact_technical_details?.quelle ?? []).join(" ");
  const hasOt =
    /ZCL_EXT_TOURANLAGE_OT|ZEXTO_PARAMETER|OT_UPDATE/i.test(snapSources) ||
    true;
  if (hasOt && result.sources.length === 0 && result.status === "ok") {
    ok = false;
    notes.push("no sources on answerable Optitool result");
  }
  if (notes.length === 0) notes.push("core claims / status aligned with snapshot");
  return { ok, notes };
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  getLocalDataRoot();
  const projects = await fileProjectRepository.list();
  const projectId = projects[0]?.id;
  if (!projectId) {
    console.error("Kein lokales Projekt — npm run seed:demo-project");
    process.exit(2);
  }

  const outDir = resolve(process.cwd(), "tmp/regression");
  mkdirSync(outDir, { recursive: true });
  const report: Record<string, unknown> = { at: new Date().toISOString(), cases: {} };
  let failures = 0;

  for (const c of CASES) {
    console.error(`\n=== Case ${c.id}: ${c.question}`);
    const result = await answerQuestion({
      projectId,
      question: c.question,
      searchMode: "direct_rag",
    });
    const summary = summarize(result);
    const check = checkExpectation(c.expect, result);
    let optitool: { ok: boolean; notes: string[] } | null = null;
    if (c.id === "A") {
      optitool = compareOptitoolSnapshot(result);
      if (!optitool.ok) check.ok = false;
    }
    // DESADV must not answer with OT_UPDATE_CUSTOMER as if it were DESADV evidence
    if (c.id === "B") {
      const ans = (result.direct_answer ?? "").toLowerCase();
      const processBlob = JSON.stringify(result.process_answer ?? {}).toLowerCase();
      if (
        result.status === "ok" ||
        (/ot_update_customer/.test(processBlob) &&
          !/nicht|keine belastbare|ähnlich/.test(ans))
      ) {
        check.ok = false;
        check.detail += " · DESADV false answer risk";
      }
    }
    if (c.id === "C") {
      const ans = (result.direct_answer ?? "").toLowerCase();
      if (/konzernfarbe\s*'?08'?/.test(ans) && /pepsi/.test(ans)) {
        check.ok = false;
        check.detail += " · Pepsi answered with Coca-Cola rule";
      }
    }

    const row = {
      expect: c.expect,
      pass: check.ok,
      check: check.detail,
      optitool_regression: optitool,
      summary,
    };
    (report.cases as Record<string, unknown>)[c.id] = row;
    console.error(
      JSON.stringify(
        {
          id: c.id,
          pass: check.ok,
          ...summary,
          optitool,
        },
        null,
        2,
      ),
    );
    if (!check.ok) failures += 1;
  }

  const outPath = resolve(outDir, "relevance-gate-cases.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.error(`\nWrote ${outPath}`);
  console.error(failures ? `${failures} case(s) failed` : "All cases passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
