/**
 * Answer-contract regressions A–E (Direct RAG retrieval unchanged).
 *   npx tsx scripts/answer-contract-regression.ts
 */
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { loadEnvFile } from "../src/lib/core/loadEnv";
import { getLocalDataRoot } from "../src/lib/localData/root";
import { fileProjectRepository } from "../src/lib/localAuth/projectRepository";
import { answerQuestion } from "../src/lib/knowledge/answerQuestion";

type CaseId = "A" | "B" | "C" | "D" | "E";

const CASES: Array<{
  id: CaseId;
  question: string;
  check: (
    r: Awaited<ReturnType<typeof answerQuestion>>,
  ) => { ok: boolean; detail: string };
}> = [
  {
    id: "A",
    question: "Welche Besonderheiten gibt es für Pepsi Cola?",
    check: (r) => {
      const blob = JSON.stringify({
        pa: r.process_answer,
        ans: r.direct_answer,
      }).toLowerCase();
      const positiveCoca =
        /konzernfarbe\s*'?08'?/.test(blob) &&
        /pepsi/.test(blob) &&
        !/nicht|keine belastbare|ähnlich|nicht anwendbar|nicht übertragen/.test(
          blob,
        );
      const ok =
        r.status === "insufficient" &&
        !positiveCoca &&
        !r.process_answer.has_safe_process_claim;
      return {
        ok,
        detail: `status=${r.status} safe=${r.process_answer.has_safe_process_claim} positiveCocaLeak=${positiveCoca}`,
      };
    },
  },
  {
    id: "B",
    question: "Welche Besonderheiten gibt es für Coca Cola?",
    check: (r) => {
      const confirmed = JSON.stringify(r.process_answer.confirmed ?? []).toLowerCase();
      const inferred = JSON.stringify(r.process_answer.inferred ?? []).toLowerCase();
      const open = JSON.stringify(r.process_answer.open ?? []).toLowerCase();
      const tech = JSON.stringify({
        ta: r.technical_answer,
        td: r.technical_details,
        compact: r.compact_technical_details,
      }).toLowerCase();
      const has08 =
        /'?08'?/.test(confirmed) ||
        /'?08'?/.test(tech) ||
        /konzernfarbe/.test(confirmed + tech);
      const hasRg = /'rg'|\brg\b|parvw|partnerrolle/.test(confirmed + tech);
      const purposeConfirmed = /segmentierung|interne steuerung|kundenarchitektur|prozessoptimierung/.test(
        confirmed,
      );
      const purposeInferredOrOpen =
        /vermutlich|deutet|abgeleitet|nicht dokumentiert|organisatorischen ziele|fachliche[rn]? hintergrund/.test(
          inferred + open,
        ) || !purposeConfirmed;
      const ok =
        r.status === "ok" &&
        has08 &&
        hasRg &&
        !purposeConfirmed &&
        purposeInferredOrOpen;
      return {
        ok,
        detail: `status=${r.status} 08=${has08} rg=${hasRg} purposeConfirmed=${purposeConfirmed}`,
      };
    },
  },
  {
    id: "C",
    question:
      "Wie ist das virtuelle Lager über ZVLAGER_AUART / ZZTVAG (Edeka) umgesetzt?",
    check: (r) => {
      const blob = JSON.stringify({
        pa: r.process_answer,
        tech: r.technical_answer,
        sources: r.sources.map((s) => s.source_key + s.title),
        compact: r.compact_technical_details,
      }).toLowerCase();
      const hasZvlager = /zvlager_auart|zztvag/.test(blob);
      const konzernConfirmed = r.process_answer.confirmed.some((s) =>
        /konzernfarbe|set_konzernfarbe/i.test(s.text),
      );
      // Honest insufficient without Konzernfarbe transfer also acceptable if
      // Direct RAG finds no virtual-warehouse evidence for the entity.
      const ok =
        (r.status === "ok" && hasZvlager && !konzernConfirmed) ||
        (r.status === "insufficient" && !konzernConfirmed);
      return {
        ok,
        detail: `status=${r.status} zvlager=${hasZvlager} konzernConfirmed=${konzernConfirmed}`,
      };
    },
  },
  {
    id: "D",
    question: "Wo wird zwischen Optitool alt und neu unterschieden?",
    check: (r) => {
      const blob = JSON.stringify({
        pa: r.process_answer,
        tech: r.technical_answer,
        compact: r.compact_technical_details,
        sources: r.sources.map(
          (s) => s.source_key + s.title + s.object_name + s.subobject_name,
        ),
      });
      const hasAlt =
        /OT_UPDATE_CUSTOMER(?!_NEW)|ZOTCO_IMPORT|DOWNLOAD_OPTO|UPLOAD_OPTO|ZEXTO_PARAMETER|\balt\b/i.test(
          blob,
        );
      const hasNeu =
        /OT_UPDATE_CUSTOMER_NEW|ZCO_IMPORT_NEW|DELETE_ORDER_NEW|BUILD_.*_NEW|\bneu\b/i.test(
          blob,
        );
      const onlyDeleteNew =
        /DELETE_ORDER_NEW/i.test(blob) &&
        !/OT_UPDATE_CUSTOMER|ZOTCO_IMPORT|UPLOAD_OPTO|DOWNLOAD_OPTO/i.test(blob);
      // Prefer both sides in sources; accept honest single-source answer that
      // still discusses alt+neu if retrieval only grounded one primary unit.
      const bothUpdate =
        /OT_UPDATE_CUSTOMER(?!_NEW)/i.test(blob) &&
        /OT_UPDATE_CUSTOMER_NEW/i.test(blob);
      const ok =
        r.status === "ok" &&
        hasAlt &&
        hasNeu &&
        !onlyDeleteNew &&
        (bothUpdate || /UPLOAD_OPTO|DOWNLOAD_OPTO|ZOTCO|ZCO_IMPORT/i.test(blob));
      return {
        ok,
        detail: `status=${r.status} alt=${hasAlt} neu=${hasNeu} bothUpdate=${bothUpdate} onlyDeleteNew=${onlyDeleteNew}`,
      };
    },
  },
  {
    id: "E",
    question:
      "Welche Sonderlogik gibt es für Kunde ZX_UNKNOWN_CUSTOMER_999 in Tabelle ZNO_SUCH_TABLE_XYZ?",
    check: (r) => {
      const ok =
        r.status === "insufficient" ||
        (!r.process_answer.has_safe_process_claim &&
          /nicht belastbar|keine belastbare|nicht dokumentiert|nicht belegt/i.test(
            r.direct_answer + JSON.stringify(r.process_answer.open ?? []),
          ));
      const invented = /ZX_UNKNOWN_CUSTOMER_999.*(setzt|prüft|schreibt)/i.test(
        r.direct_answer,
      );
      return {
        ok: ok && !invented,
        detail: `status=${r.status} safe=${r.process_answer.has_safe_process_claim} invented=${invented}`,
      };
    },
  },
];

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
  const report: Record<string, unknown> = {
    at: new Date().toISOString(),
    search_mode: "direct_rag",
    cases: {},
  };
  let failures = 0;

  for (const c of CASES) {
    console.error(`\n=== Case ${c.id}: ${c.question}`);
    const result = await answerQuestion({
      projectId,
      question: c.question,
      searchMode: "direct_rag",
    });
    const check = c.check(result);
    if (!check.ok) failures += 1;
    const row = {
      pass: check.ok,
      check: check.detail,
      status: result.status,
      intent: result.question_intent,
      has_safe_process_claim: result.process_answer.has_safe_process_claim,
      confirmed: result.process_answer.confirmed?.map((s) => s.text) ?? [],
      inferred: result.process_answer.inferred?.map((s) => s.text) ?? [],
      open: result.process_answer.open?.map((s) => s.text) ?? [],
      technical_sections: {
        entry_point: result.technical_answer?.entry_point?.length ?? 0,
        trigger: result.technical_answer?.trigger?.length ?? 0,
        results: result.technical_answer?.results?.length ?? 0,
      },
      evidence_context: result.evidence_context_report,
      direct_answer: result.direct_answer?.slice(0, 400),
      source_keys: result.sources.slice(0, 8).map((s) => s.source_key),
      answerability: result.relevance_gate?.answerability ?? null,
    };
    (report.cases as Record<string, unknown>)[c.id] = row;
    console.error(JSON.stringify({ id: c.id, ...row }, null, 2));
    writeFileSync(
      resolve(outDir, `contract-${c.id.toLowerCase()}.json`),
      JSON.stringify(result, null, 2),
    );
  }

  writeFileSync(
    resolve(outDir, "answer-contract-cases.json"),
    JSON.stringify(report, null, 2),
  );
  console.error(`\n${failures === 0 ? "PASS" : "FAIL"} — ${5 - failures}/5 cases`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
