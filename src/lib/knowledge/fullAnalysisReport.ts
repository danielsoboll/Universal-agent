/**
 * Vollanalyse report assembly — Markdown + .docx from structured ask output.
 * OpenAI never returns binary Word; we convert server-side.
 */

import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  AlignmentType,
} from "docx";
import type {
  ProcessAnswer,
  TechnicalAnswer,
  CompactTechnicalDetails,
} from "@/lib/knowledge/answerSchema";
import type { KnowledgeHit } from "@/lib/knowledge/types";
import { FULL_ANALYSIS_VERSION } from "@/lib/knowledge/askModeVersions";

export type FullAnalysisReport = {
  title: string;
  markdown: string;
  /** base64-encoded .docx bytes */
  docx_base64: string;
  filename_stem: string;
  version: typeof FULL_ANALYSIS_VERSION;
};

function levelLabel(level: string): string {
  switch (level) {
    case "confirmed":
      return "belegt";
    case "inferred":
      return "abgeleitet";
    case "possible":
      return "möglich";
    case "not_supported":
      return "nicht belegt";
    case "contradicted":
      return "widersprochen";
    default:
      return level;
  }
}

function statementsToMd(
  items: Array<{ text: string; level: string; source_ranks?: number[] }>,
): string {
  if (!items.length) return "_Keine Einträge._\n";
  return items
    .map((s) => {
      const ranks =
        s.source_ranks && s.source_ranks.length
          ? ` (Quellen #${s.source_ranks.join(", #")})`
          : "";
      return `- **[${levelLabel(s.level)}]** ${s.text}${ranks}`;
    })
    .join("\n");
}

function slugFilename(question: string): string {
  const stem = question
    .trim()
    .slice(0, 60)
    .replace(/[^\wÄÖÜäöüß\- ]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const date = new Date().toISOString().slice(0, 10);
  return `Vollanalyse_${stem || "Thema"}_${date}`;
}

export function buildFullAnalysisMarkdown(params: {
  question: string;
  processAnswer: ProcessAnswer | null | undefined;
  technicalAnswer: TechnicalAnswer | null | undefined;
  compactTechnicalDetails?: CompactTechnicalDetails | null;
  sources: Array<
    Pick<
      KnowledgeHit,
      | "rank"
      | "title"
      | "source_key"
      | "knowledge_unit_type"
      | "object_name"
      | "subobject_name"
      | "snippet"
      | "combined_score"
    >
  >;
  retrievalSummary?: string;
  durationMs?: number;
  warnings?: string[];
}): string {
  const pa = params.processAnswer;
  const ta = params.technicalAnswer;
  const lines: string[] = [
    `# Vollanalyse`,
    "",
    `**Thema / Frage:** ${params.question}`,
    "",
    `*Einmalige, umfangreiche Auswertung — isoliert ohne Chat-Kontext.*`,
    "",
  ];

  if (params.retrievalSummary) {
    lines.push(`**Retrieval:** ${params.retrievalSummary}`);
  }
  if (params.durationMs != null) {
    lines.push(`**Dauer:** ${(params.durationMs / 1000).toFixed(1)} s`);
  }
  lines.push("", "---", "", "## Prozessbewertung", "");

  if (pa?.direct_answer?.trim()) {
    lines.push("### Kurzfassung", "", pa.direct_answer.trim(), "");
  }
  if (pa?.confirmed?.length) {
    lines.push("### Sicher belegt", "", statementsToMd(pa.confirmed), "");
  }
  if (pa?.inferred?.length) {
    lines.push("### Abgeleitete Bewertung", "", statementsToMd(pa.inferred), "");
  }
  if (pa?.open?.length || pa?.open_validation_questions?.length) {
    lines.push(
      "### Offen / Unsicher",
      "",
      statementsToMd(
        pa.open?.length
          ? pa.open
          : (pa.open_validation_questions ?? []).map((t) => ({
              text: t,
              level: "possible",
            })),
      ),
      "",
    );
  }
  if (pa?.business_interpretation?.trim()) {
    lines.push(
      "### Fachliche Interpretation",
      "",
      pa.business_interpretation.trim(),
      "",
    );
  }
  if (pa?.no_process_claim_message?.trim() && !pa.has_safe_process_claim) {
    lines.push("", `> ${pa.no_process_claim_message.trim()}`, "");
  }

  lines.push("---", "", "## Technische Tiefe", "");
  if (ta) {
    const sections: Array<[string, typeof ta.entry_point]> = [
      ["Einstiegspunkt", ta.entry_point],
      ["Auslöser", ta.trigger],
      ["Verarbeitung", ta.processing],
      ["Objekte", ta.objects],
      ["Ergebnisse", ta.results],
      ["Beziehungen", ta.relations],
      ["Offen (technisch)", ta.open],
    ];
    for (const [title, items] of sections) {
      if (!items?.length) continue;
      lines.push(`### ${title}`, "", statementsToMd(items), "");
    }
  }

  const compact = params.compactTechnicalDetails;
  if (compact) {
    const blocks: Array<[string, string[]]> = [
      ["Quelle", compact.quelle],
      ["Auslöser (kompakt)", compact.ausloeser],
      ["Systemaktion", compact.systemaktion],
      ["Beleg", compact.beleg],
      ["Unsicherheit", compact.unsicherheit],
    ];
    const any = blocks.some(([, v]) => v.length > 0);
    if (any) {
      lines.push("### Kompakte technische Details", "");
      for (const [title, items] of blocks) {
        if (!items.length) continue;
        lines.push(`**${title}:**`);
        for (const i of items) lines.push(`- ${i}`);
        lines.push("");
      }
    }
  }

  lines.push("---", "", "## Quellenverzeichnis", "");
  if (!params.sources.length) {
    lines.push("_Keine Quellen._", "");
  } else {
    for (const s of params.sources) {
      const label = [s.object_name, s.subobject_name].filter(Boolean).join(" / ");
      lines.push(
        `### #${s.rank} ${s.title || label || s.source_key}`,
        "",
        `- **source_key:** \`${s.source_key}\``,
        `- **Typ:** ${s.knowledge_unit_type}`,
        s.combined_score != null
          ? `- **Score:** ${s.combined_score.toFixed(3)}`
          : "",
        s.snippet ? `- **Auszug:** ${s.snippet.slice(0, 400)}` : "",
        "",
      );
    }
  }

  if (params.warnings?.length) {
    lines.push("---", "", "## Hinweise", "");
    for (const w of params.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push(
    "---",
    "",
    `*Report-Version ${FULL_ANALYSIS_VERSION} · generiert ${new Date().toISOString()}*`,
    "",
  );

  return lines.filter((l) => l !== undefined).join("\n");
}

function mdInlineToRuns(text: string): TextRun[] {
  // Very light markdown: **bold** segments
  const runs: TextRun[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      runs.push(new TextRun({ text: text.slice(last, m.index), size: 22 }));
    }
    runs.push(new TextRun({ text: m[1]!, bold: true, size: 22 }));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    runs.push(new TextRun({ text: text.slice(last), size: 22 }));
  }
  if (runs.length === 0) {
    runs.push(new TextRun({ text, size: 22 }));
  }
  return runs;
}

/**
 * Convert report markdown into a simple Word document (headings + paragraphs).
 */
export async function markdownToDocxBuffer(markdown: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [];
  const rawLines = markdown.split(/\r?\n/);

  for (const line of rawLines) {
    if (line.startsWith("# ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(2),
          heading: HeadingLevel.TITLE,
          spacing: { after: 200 },
        }),
      );
    } else if (line.startsWith("## ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(3),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 280, after: 120 },
        }),
      );
    } else if (line.startsWith("### ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(4),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 80 },
        }),
      );
    } else if (line.startsWith("---")) {
      paragraphs.push(
        new Paragraph({
          text: " ",
          spacing: { before: 120, after: 120 },
        }),
      );
    } else if (line.startsWith("> ")) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: line.slice(2),
              italics: true,
              size: 20,
              color: "555555",
            }),
          ],
          spacing: { after: 80 },
        }),
      );
    } else if (line.startsWith("- ")) {
      const body = line.slice(2).replace(/`([^`]+)`/g, "$1");
      paragraphs.push(
        new Paragraph({
          children: mdInlineToRuns(body),
          bullet: { level: 0 },
          spacing: { after: 40 },
        }),
      );
    } else if (line.trim() === "") {
      paragraphs.push(new Paragraph({ text: "" }));
    } else if (line.startsWith("*") && line.endsWith("*") && !line.startsWith("**")) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: line.replace(/^\*|\*$/g, ""),
              italics: true,
              size: 20,
              color: "666666",
            }),
          ],
          spacing: { after: 80 },
        }),
      );
    } else {
      const cleaned = line.replace(/`([^`]+)`/g, "$1");
      paragraphs.push(
        new Paragraph({
          children: mdInlineToRuns(cleaned),
          spacing: { after: 80 },
          alignment: AlignmentType.LEFT,
        }),
      );
    }
  }

  const doc = new Document({
    creator: "Universal Knowledge Analyzer",
    title: "Vollanalyse",
    description: "Einmalige Vollanalyse eines Themas",
    sections: [
      {
        properties: {},
        children:
          paragraphs.length > 0
            ? paragraphs
            : [new Paragraph({ text: "Leerer Report." })],
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export async function buildFullAnalysisReport(params: {
  question: string;
  processAnswer: ProcessAnswer | null | undefined;
  technicalAnswer: TechnicalAnswer | null | undefined;
  compactTechnicalDetails?: CompactTechnicalDetails | null;
  sources: Parameters<typeof buildFullAnalysisMarkdown>[0]["sources"];
  retrievalSummary?: string;
  durationMs?: number;
  warnings?: string[];
}): Promise<FullAnalysisReport> {
  const markdown = buildFullAnalysisMarkdown(params);
  const buf = await markdownToDocxBuffer(markdown);
  const filename_stem = slugFilename(params.question);
  return {
    title: `Vollanalyse: ${params.question.slice(0, 80)}`,
    markdown,
    docx_base64: buf.toString("base64"),
    filename_stem,
    version: FULL_ANALYSIS_VERSION,
  };
}
