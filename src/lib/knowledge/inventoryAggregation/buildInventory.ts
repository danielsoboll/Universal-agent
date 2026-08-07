/**
 * Build complete delivery-output inventory + EDI classification + chains.
 */
import { resolveMedium } from "@/lib/knowledge/anchorRag/mediumMapping";
import type { MessageIdocInventoryCorpus } from "./loadMessageIdocInventory";
import type {
  ChainLinkStatus,
  InventoryAggregation,
  OutputInventoryRow,
} from "./types";

const UNRESOLVED_EDI_NOTE = "EDI-Verarbeitung belegt";

/** NACHA = 6 or fachlich EDI (not ALE/Verteilung alone). */
export function isEdiMedium(code: string): boolean {
  const c = code.trim().toUpperCase();
  if (c === "6") return true;
  const m = resolveMedium(code, { preferLang: "DE" });
  if (m.resolution === "UNRESOLVED") return false;
  const t = m.medium_text.toLowerCase();
  return t.includes("edi") && !t.includes("ale") && !t.includes("verteilung");
}

/** Broader: EDI medium 6 or ALE distribution (IDoc-related). */
export function isEdiOrIdocMedium(code: string): boolean {
  if (isEdiMedium(code)) return true;
  const c = code.trim().toUpperCase();
  if (c === "A") return true;
  const m = resolveMedium(code, { preferLang: "DE" });
  if (m.resolution === "UNRESOLVED") return false;
  const t = m.medium_text.toLowerCase();
  return t.includes("ale") || t.includes("verteilung");
}

export function evidenceStatusFor(row: {
  is_edi_medium: boolean;
  message_type: string | null;
  idoc_type: string | null;
}): import("./types").EvidenceStatusLabel {
  if (!row.is_edi_medium) return "kein EDI-Medium";
  if (row.message_type && row.idoc_type) {
    return "vollständige IDoc-Kette belegt";
  }
  if (row.message_type && !row.idoc_type) {
    return "IDoc-Basistyp nicht eindeutig verbunden";
  }
  if (!row.message_type && row.idoc_type) {
    return "Message Type nicht eindeutig verbunden";
  }
  // Medium 6 belegt EDI, Kette aber noch nicht eindeutig.
  return "EDI-Verarbeitung belegt";
}

function textFor(
  corpus: MessageIdocInventoryCorpus,
  application: string,
  output_type: string,
): { text: string | null; source: string | null } {
  const de = corpus.texts.find(
    (t) =>
      t.application === application &&
      t.output_type === output_type &&
      (t.language === "DE" || t.language === "D"),
  );
  if (de) return { text: de.text, source: de.source_path };
  const any = corpus.texts.find(
    (t) => t.application === application && t.output_type === output_type,
  );
  return any
    ? { text: any.text, source: any.source_path }
    : { text: null, source: null };
}

function parseOutputFromRelationName(from_name: string): {
  application: string;
  output_type: string;
} | null {
  // Formats: "V2|LAVA" or "B|V2|LAVA"
  const parts = from_name.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    return { application: parts[0]!, output_type: parts[1]! };
  }
  if (parts.length >= 3 && parts[0] === "B") {
    return { application: parts[1]!, output_type: parts[2]! };
  }
  if (parts.length >= 3) {
    return { application: parts[1]!, output_type: parts[2]! };
  }
  return null;
}

type ChainResolution = {
  message_type: string | null;
  idoc_type: string | null;
  idoc_extension: string | null;
  partner_profiles: string[];
  status: ChainLinkStatus;
  note: string | null;
  relation_sources: string[];
};

function resolveChain(
  corpus: MessageIdocInventoryCorpus,
  application: string,
  output_type: string,
  program: string | null,
  isEdi: boolean,
): ChainResolution {
  const relation_sources: string[] = [];
  const partner_profiles: string[] = [];

  // Direct OUTPUT_TYPE → MESSAGE_TYPE (none in current 11 export — keep for future)
  for (const r of corpus.relations11) {
    if (r.from_type !== "OUTPUT_TYPE") continue;
    const parsed = parseOutputFromRelationName(r.from_name);
    if (
      !parsed ||
      parsed.application !== application ||
      parsed.output_type !== output_type
    ) {
      continue;
    }
    if (r.to_type === "MESSAGE_TYPE") {
      relation_sources.push(r.source_path);
      const message_type = r.to_name;
      const idocs = corpus.message_to_idoc.filter(
        (m) => m.message_type === message_type,
      );
      const exts = corpus.message_to_extension.filter(
        (m) => m.message_type === message_type,
      );
      for (const i of idocs) relation_sources.push(i.source_path);
      return {
        message_type,
        idoc_type: idocs[0]?.idoc_type ?? null,
        idoc_extension: exts[0]?.extension ?? null,
        partner_profiles,
        status: "direct",
        note: null,
        relation_sources: [...new Set(relation_sources)],
      };
    }
  }

  // Via program: only if an explicit relation ties this output's program context
  // to a message type (not name-guessing). Currently no such edges → skip inventing.
  if (program) {
    for (const r of corpus.relations11) {
      if (
        r.from_type === "PROGRAM" &&
        r.from_name === program &&
        r.to_type === "MESSAGE_TYPE"
      ) {
        relation_sources.push(r.source_path);
        const message_type = r.to_name;
        const idocs = corpus.message_to_idoc.filter(
          (m) => m.message_type === message_type,
        );
        const exts = corpus.message_to_extension.filter(
          (m) => m.message_type === message_type,
        );
        return {
          message_type,
          idoc_type: idocs[0]?.idoc_type ?? null,
          idoc_extension: exts[0]?.extension ?? null,
          partner_profiles,
          status: "via_program",
          note: null,
          relation_sources: [...new Set(relation_sources)],
        };
      }
    }
  }

  // Partner profile: only if relation contexts on this OUTPUT_TYPE list partners
  // that configure a message type.
  for (const r of corpus.relations11) {
    if (r.from_type !== "OUTPUT_TYPE") continue;
    const parsed = parseOutputFromRelationName(r.from_name);
    if (
      !parsed ||
      parsed.application !== application ||
      parsed.output_type !== output_type
    ) {
      continue;
    }
    for (const partner of r.partner_profiles) {
      const msgs = corpus.partner_to_message.filter((p) => p.partner === partner);
      if (msgs.length === 1) {
        relation_sources.push(r.source_path, msgs[0]!.source_path);
        partner_profiles.push(partner);
        const message_type = msgs[0]!.message_type;
        const idocs = corpus.message_to_idoc.filter(
          (m) => m.message_type === message_type,
        );
        const exts = corpus.message_to_extension.filter(
          (m) => m.message_type === message_type,
        );
        return {
          message_type,
          idoc_type: idocs[0]?.idoc_type ?? null,
          idoc_extension: exts[0]?.extension ?? null,
          partner_profiles,
          status: "via_partner_profile",
          note: null,
          relation_sources: [...new Set(relation_sources)],
        };
      }
    }
  }

  if (isEdi) {
    return {
      message_type: null,
      idoc_type: null,
      idoc_extension: null,
      partner_profiles,
      status: "unresolved",
      note: UNRESOLVED_EDI_NOTE,
      relation_sources,
    };
  }

  return {
    message_type: null,
    idoc_type: null,
    idoc_extension: null,
    partner_profiles,
    status: "unresolved",
    note: null,
    relation_sources,
  };
}

export function buildOutputInventoryRows(params: {
  corpus: MessageIdocInventoryCorpus;
  application: string;
}): OutputInventoryRow[] {
  const { corpus, application } = params;
  const otByType = new Map(
    corpus.output_types
      .filter((o) => o.application === application)
      .map((o) => [o.output_type, o] as const),
  );
  // Authoritative set: T685 output types ∪ TNAPR processing keys for this app.
  // TNAPR-only rows are still real output configuration of the application
  // (not invented from code/name similarity).
  const typeIds = new Set<string>([
    ...otByType.keys(),
    ...corpus.processing
      .filter((p) => p.application === application)
      .map((p) => p.output_type),
  ]);

  const rows: OutputInventoryRow[] = [];

  for (const output_type of [...typeIds].sort()) {
    const ot = otByType.get(output_type);
    const { text, source: textSource } = textFor(
      corpus,
      application,
      output_type,
    );
    const procs = corpus.processing.filter(
      (p) =>
        p.application === application && p.output_type === output_type,
    );

    const procList =
      procs.length > 0
        ? procs
        : [
            {
              application,
              output_type,
              medium: "",
              program: null as string | null,
              routine: null as string | null,
              form: null as string | null,
              object_id: "",
              source_table: "TNAPR",
              source_path:
                ot?.source_path ??
                "canonical/message-idoc-config/objects.jsonl",
            },
          ];

    for (const proc of procList) {
      const mediumRes = resolveMedium(proc.medium, { preferLang: "DE" });
      const isEdi = isEdiMedium(proc.medium);
      const isEdiOrIdoc = isEdiOrIdocMedium(proc.medium);
      const chain = resolveChain(
        corpus,
        application,
        output_type,
        proc.program,
        isEdi,
      );
      const distinct_key = [
        application,
        output_type,
        proc.medium || "",
        proc.program || "",
        proc.routine || "",
      ].join("|");
      const evidence_status = evidenceStatusFor({
        is_edi_medium: isEdi,
        message_type: chain.message_type,
        idoc_type: chain.idoc_type,
      });
      const chain_complete = Boolean(
        isEdi && chain.message_type && chain.idoc_type,
      );

      rows.push({
        application,
        output_type,
        description: text,
        transmission_medium: proc.medium,
        medium_text: mediumRes.medium_text,
        medium_resolution: mediumRes.resolution,
        program: proc.program,
        routine: proc.routine,
        form: proc.form,
        distinct_key,
        is_edi_medium: isEdi,
        is_edi_or_idoc_medium: isEdiOrIdoc,
        message_type: chain.message_type,
        idoc_type: chain.idoc_type,
        idoc_extension: chain.idoc_extension,
        partner_profiles: chain.partner_profiles,
        chain_status: chain.status,
        chain_note: chain.note ?? (isEdi && !chain_complete ? UNRESOLVED_EDI_NOTE : null),
        evidence_status,
        chain_complete,
        evidence: {
          output_source: ot
            ? `${ot.source_path} (${ot.source_table})`
            : `${proc.source_path} (${proc.source_table}, ohne T685-Stamm)`,
          processing_source: `${proc.source_path} (${proc.source_table})`,
          text_source: textSource,
          relation_sources: chain.relation_sources,
        },
      });
    }
  }

  // Deduplicate by distinct_key
  const seen = new Set<string>();
  const unique: OutputInventoryRow[] = [];
  for (const r of rows) {
    if (seen.has(r.distinct_key)) continue;
    seen.add(r.distinct_key);
    unique.push(r);
  }
  unique.sort((a, b) =>
    a.output_type === b.output_type
      ? a.transmission_medium.localeCompare(b.transmission_medium)
      : a.output_type.localeCompare(b.output_type),
  );
  return unique;
}

export function aggregateInventory(rows: OutputInventoryRow[]): InventoryAggregation {
  const allTypes = new Set(rows.map((r) => r.output_type));
  const ediTypes = new Set(
    rows.filter((r) => r.is_edi_medium).map((r) => r.output_type),
  );
  const otherTypes = new Set(
    [...allTypes].filter((t) => !ediTypes.has(t)),
  );

  const mediumByType = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.transmission_medium}|${r.medium_text}`;
    const set = mediumByType.get(key) ?? new Set();
    set.add(r.output_type);
    mediumByType.set(key, set);
  }
  const medium_distribution = [...mediumByType.entries()]
    .map(([key, set]) => {
      const [medium, ...rest] = key.split("|");
      return {
        medium: medium ?? "",
        medium_text: rest.join("|"),
        count: set.size,
      };
    })
    .sort((a, b) => b.count - a.count);

  let fully_resolved_chains = 0;
  let unresolved_edi_chains = 0;
  const msgTypes = new Set<string>();
  const idocTypes = new Set<string>();
  for (const t of ediTypes) {
    const ediRows = rows.filter((r) => r.output_type === t && r.is_edi_medium);
    const withMsg = ediRows.find((r) => r.message_type);
    const withIdoc = ediRows.find((r) => r.idoc_type);
    if (withMsg?.message_type) msgTypes.add(withMsg.message_type);
    if (withIdoc?.idoc_type) idocTypes.add(withIdoc.idoc_type);
    const resolved = ediRows.some((r) => r.chain_complete);
    if (resolved) fully_resolved_chains += 1;
    else unresolved_edi_chains += 1;
  }

  return {
    total_output_types: allTypes.size,
    edi_medium_output_types: ediTypes.size,
    other_media_output_types: otherTypes.size,
    medium_distribution,
    fully_resolved_chains,
    unresolved_edi_chains,
    resolved_message_type_count: msgTypes.size,
    resolved_idoc_type_count: idocTypes.size,
  };
}

export { UNRESOLVED_EDI_NOTE };
