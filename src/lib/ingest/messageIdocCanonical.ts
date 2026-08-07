/**
 * Stream RAW message-idoc-config JSONL → canonical objects + relations.
 * No OpenAI. Excludes admin/user fields. Keeps partner numbers complete.
 */

import { createHash } from "crypto";
import { createReadStream, existsSync, statSync } from "fs";
import { createInterface } from "readline";
import { createWriteStream } from "fs";
import { finished } from "stream/promises";
import {
  CONFIG_GROUPS,
  EXPECTED_SOURCE_TABLES,
  RAW_FOLDER_PARTS,
  type MessageIdocConfigGroup,
  type MessageIdocCanonicalObjectType,
  type MessageIdocRelationKind,
} from "@/lib/admin/datenbasis/messageIdocConfig/constants";
import { detectMessageIdocRawFiles } from "@/lib/admin/datenbasis/messageIdocConfig/detectRaw";
import { isAuthoritativeOutputTypeKvewe } from "@/lib/domain/typeAuthority";
import {
  ensureWritableDir,
  writeGeneratedText,
} from "@/lib/localData/fs";
import { resolveRawPath, resolveWritablePath } from "@/lib/localData/paths";

const EXCLUDE_FIELDS = new Set(
  [
    "USRKEY",
    "USRTYP",
    "USRLNG",
    "CREUSER",
    "CHAUSER",
    "CREDATE",
    "CRETIME",
    "CHADATE",
    "CHATIME",
    "LDATE",
    "LTIME",
    "PRESP",
    "PWORK",
    "PLAST",
    "MANDT",
    "MANDANT",
  ].map((s) => s.toUpperCase()),
);

export type CanonicalObject = {
  object_type: MessageIdocCanonicalObjectType;
  object_id: string;
  display_name: string | null;
  source: {
    raw_file: string;
    config_group: string;
    source_table: string;
    system_id: string | null;
    client: string | null;
  };
  attributes: Record<string, unknown>;
  _canonical_key: string;
};

export type CanonicalRelation = {
  relation_kind: MessageIdocRelationKind;
  from_object_type: MessageIdocCanonicalObjectType;
  from_object_id: string;
  to_object_type: MessageIdocCanonicalObjectType | "external_technical";
  to_object_id: string;
  attributes: Record<string, unknown>;
  source: {
    raw_file: string;
    config_group: string;
    source_table: string;
  };
  _canonical_key: string;
};

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function pickAttrs(
  values: Record<string, unknown>,
  keep?: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allow = keep ? new Set(keep.map((k) => k.toUpperCase())) : null;
  for (const [k, v] of Object.entries(values)) {
    const ku = k.toUpperCase();
    if (EXCLUDE_FIELDS.has(ku)) continue;
    if (allow && !allow.has(ku)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[ku] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

function keyOf(...parts: string[]): string {
  return parts
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0)
    .join("|");
}

function canonicalKey(
  objectType: string,
  objectId: string,
): string {
  return createHash("sha256")
    .update(`${objectType}:${objectId}`)
    .digest("hex")
    .slice(0, 24);
}

function relationKey(r: Omit<CanonicalRelation, "_canonical_key">): string {
  return createHash("sha256")
    .update(
      `${r.relation_kind}|${r.from_object_type}|${r.from_object_id}|${r.to_object_type}|${r.to_object_id}`,
    )
    .digest("hex")
    .slice(0, 24);
}

type RowCtx = {
  rawFile: string;
  configGroup: string;
  sourceTable: string;
  systemId: string | null;
  client: string | null;
  values: Record<string, unknown>;
};

function emitObject(
  map: Map<string, CanonicalObject>,
  obj: Omit<CanonicalObject, "_canonical_key">,
): CanonicalObject {
  const _canonical_key = canonicalKey(obj.object_type, obj.object_id);
  const full = { ...obj, _canonical_key };
  const existing = map.get(_canonical_key);
  if (existing) {
    existing.attributes = { ...existing.attributes, ...obj.attributes };
    if (!existing.display_name && obj.display_name) {
      existing.display_name = obj.display_name;
    }
    return existing;
  }
  map.set(_canonical_key, full);
  return full;
}

function emitRelation(
  map: Map<string, CanonicalRelation>,
  rel: Omit<CanonicalRelation, "_canonical_key">,
): void {
  if (!rel.to_object_id) return;
  const _canonical_key = relationKey(rel);
  if (map.has(_canonical_key)) return;
  map.set(_canonical_key, { ...rel, _canonical_key });
}

function mapRow(
  ctx: RowCtx,
  objects: Map<string, CanonicalObject>,
  relations: Map<string, CanonicalRelation>,
  unmapped: Array<Record<string, unknown>>,
): void {
  const t = ctx.sourceTable.toUpperCase();
  const v = ctx.values;
  const src = {
    raw_file: ctx.rawFile,
    config_group: ctx.configGroup,
    source_table: t,
    system_id: ctx.systemId,
    client: ctx.client,
  };
  const relSrc = {
    raw_file: ctx.rawFile,
    config_group: ctx.configGroup,
    source_table: t,
  };

  switch (t) {
    case "T685": {
      const kvewe = str(v.KVEWE);
      // T685 holds many condition usages. Only KVEWE=B is Nachrichten/OUTPUT_TYPE.
      // KVEWE=A (Pricing) etc. must not become output_type nodes.
      if (!isAuthoritativeOutputTypeKvewe(kvewe)) {
        break;
      }
      const id = keyOf(kvewe, str(v.KAPPL), str(v.KSCHL));
      if (!id) break;
      emitObject(objects, {
        object_type: "output_type",
        object_id: id,
        display_name: str(v.KSCHL) || null,
        source: src,
        attributes: pickAttrs(v, [
          "KVEWE",
          "KAPPL",
          "KSCHL",
          "KOZGF",
          "DATVO",
          "DTVOB",
        ]),
      });
      break;
    }
    case "T685T": {
      const kvewe = str(v.KVEWE);
      if (!isAuthoritativeOutputTypeKvewe(kvewe)) {
        break;
      }
      const id = keyOf(kvewe, str(v.KAPPL), str(v.KSCHL), str(v.SPRAS));
      const parent = keyOf(kvewe, str(v.KAPPL), str(v.KSCHL));
      if (!id) break;
      emitObject(objects, {
        object_type: "output_type_text",
        object_id: id,
        display_name: str(v.VTEXT) || null,
        source: src,
        attributes: {
          ...pickAttrs(v, ["KVEWE", "KAPPL", "KSCHL", "SPRAS", "VTEXT"]),
          parent_output_type_id: parent || null,
        },
      });
      break;
    }
    case "TNAPR": {
      const id = keyOf(str(v.KAPPL), str(v.KSCHL), str(v.NACHA));
      const outType = keyOf(str(v.KVEWE) || "B", str(v.KAPPL), str(v.KSCHL));
      // T685 uses KVEWE; TNAPR often only KAPPL+KSCHL — link via KAPPL|KSCHL soft match later
      const outTypeAlt = keyOf("B", str(v.KAPPL), str(v.KSCHL));
      if (!id) break;
      emitObject(objects, {
        object_type: "output_processing",
        object_id: id,
        display_name: str(v.KSCHL) || null,
        source: src,
        attributes: pickAttrs(v, [
          "KAPPL",
          "KSCHL",
          "NACHA",
          "PGNAM",
          "RONAM",
          "FONAM",
          "PGNAM2",
          "RONAM2",
          "FONAM2",
          "FUNCNAME",
          "SFORM",
          "FORMTYPE",
        ]),
      });
      const pgnam = str(v.PGNAM);
      if (pgnam) {
        emitRelation(relations, {
          relation_kind: "OUTPUT_TYPE_TO_PROGRAM",
          from_object_type: "output_type",
          from_object_id: outTypeAlt,
          to_object_type: "external_technical",
          to_object_id: pgnam.toUpperCase(),
          attributes: { via: "TNAPR.PGNAM", processing_id: id },
          source: relSrc,
        });
        emitRelation(relations, {
          relation_kind: "TECHNICAL_OBJECT_TO_PROGRAM",
          from_object_type: "output_processing",
          from_object_id: id,
          to_object_type: "external_technical",
          to_object_id: pgnam.toUpperCase(),
          attributes: { field: "PGNAM" },
          source: relSrc,
        });
      }
      const ronam = str(v.RONAM);
      if (ronam) {
        emitRelation(relations, {
          relation_kind: "OUTPUT_TYPE_TO_ROUTINE",
          from_object_type: "output_type",
          from_object_id: outTypeAlt,
          to_object_type: "external_technical",
          to_object_id: ronam.toUpperCase(),
          attributes: { via: "TNAPR.RONAM", processing_id: id },
          source: relSrc,
        });
      }
      void outType;
      break;
    }
    case "EDMSG": {
      const id = keyOf(str(v.MSGTYP) || str(v.MESTYP));
      if (!id) break;
      emitObject(objects, {
        object_type: "ale_message_type",
        object_id: id,
        display_name: id,
        source: src,
        attributes: pickAttrs(v, ["MSGTYP", "MESTYP"]),
      });
      break;
    }
    case "EDIMSGT": {
      const mestyp = str(v.MESTYP) || str(v.MSGTYP);
      const id = keyOf(mestyp, str(v.LANGUA));
      if (!id) break;
      emitObject(objects, {
        object_type: "ale_message_type_text",
        object_id: id,
        display_name: str(v.DESCRP) || null,
        source: src,
        attributes: pickAttrs(v, ["MESTYP", "MSGTYP", "LANGUA", "DESCRP"]),
      });
      break;
    }
    case "EDIMSG": {
      const mestyp = str(v.MESTYP);
      const idoctyp = str(v.IDOCTYP);
      const cimtyp = str(v.CIMTYP);
      const id = keyOf(mestyp, idoctyp, cimtyp || "∅");
      if (!mestyp || !idoctyp) break;
      emitObject(objects, {
        object_type: "message_type_idoc_assignment",
        object_id: id,
        display_name: `${mestyp}→${idoctyp}`,
        source: src,
        attributes: pickAttrs(v, [
          "MESTYP",
          "IDOCTYP",
          "CIMTYP",
          "RELEASED",
          "ACTFLAG",
        ]),
      });
      emitRelation(relations, {
        relation_kind: "MESSAGE_TYPE_TO_IDOC_TYPE",
        from_object_type: "ale_message_type",
        from_object_id: mestyp,
        to_object_type: "idoc_type",
        to_object_id: idoctyp,
        attributes: { cimtyp: cimtyp || null, assignment_id: id },
        source: relSrc,
      });
      if (cimtyp) {
        emitObject(objects, {
          object_type: "idoc_extension",
          object_id: cimtyp,
          display_name: cimtyp,
          source: src,
          attributes: { CIMTYP: cimtyp, IDOCTYP: idoctyp },
        });
        emitRelation(relations, {
          relation_kind: "IDOC_TYPE_TO_EXTENSION",
          from_object_type: "idoc_type",
          from_object_id: idoctyp,
          to_object_type: "idoc_extension",
          to_object_id: cimtyp,
          attributes: { mestyp },
          source: relSrc,
        });
      }
      emitObject(objects, {
        object_type: "idoc_type",
        object_id: idoctyp,
        display_name: idoctyp,
        source: src,
        attributes: { IDOCTYP: idoctyp },
      });
      break;
    }
    case "EDIDO": {
      const id = keyOf(str(v.DOCTYP));
      if (!id) break;
      emitObject(objects, {
        object_type: "idoc_type",
        object_id: id,
        display_name: id,
        source: src,
        attributes: pickAttrs(v, [
          "DOCTYP",
          "IDOCTYP",
          "PRETYP",
          "CLOSED",
          "RELEASED",
        ]),
      });
      break;
    }
    case "EDIDOT": {
      const id = keyOf(str(v.DOCTYP), str(v.LANGUA));
      if (!id) break;
      emitObject(objects, {
        object_type: "idoc_type_text",
        object_id: id,
        display_name: str(v.DESCRP) || null,
        source: src,
        attributes: pickAttrs(v, ["DOCTYP", "LANGUA", "DESCRP"]),
      });
      break;
    }
    case "EDISEG": {
      const id = keyOf(str(v.SEGNAM) || str(v.SEGTYP));
      if (!id) break;
      emitObject(objects, {
        object_type: "idoc_segment",
        object_id: id,
        display_name: id,
        source: src,
        attributes: pickAttrs(v, [
          "SEGNAM",
          "SEGTYP",
          "SEGLEN",
          "RELEASED",
          "CLOSED",
        ]),
      });
      break;
    }
    case "EDISDEF": {
      const seg = str(v.SEGTYP);
      const id = keyOf(seg, str(v.VERSION) || str(v.SEGDEF) || "0");
      if (!seg) break;
      // Enrich segment object; keep definition as attributes on segment via relation note
      emitObject(objects, {
        object_type: "idoc_segment",
        object_id: seg,
        display_name: seg,
        source: src,
        attributes: {
          ...pickAttrs(v, ["SEGTYP", "VERSION", "SEGDEF", "FIELDNUM", "EXPLENG"]),
          _definition_id: id,
        },
      });
      break;
    }
    case "EDISEGT": {
      const id = keyOf(str(v.SEGTYP), str(v.LANGUA));
      if (!id) break;
      emitObject(objects, {
        object_type: "idoc_segment_text",
        object_id: id,
        display_name: str(v.DESCRP) || null,
        source: src,
        attributes: pickAttrs(v, ["SEGTYP", "LANGUA", "DESCRP"]),
      });
      break;
    }
    case "EDISYN": {
      const idoctyp = str(v.IDOCTYP);
      const seg = str(v.SEGTYP);
      const cim = str(v.CIMTYP);
      if (idoctyp && seg) {
        emitRelation(relations, {
          relation_kind: "IDOC_TYPE_TO_SEGMENT",
          from_object_type: "idoc_type",
          from_object_id: idoctyp,
          to_object_type: "idoc_segment",
          to_object_id: seg,
          attributes: pickAttrs(v, [
            "POSNO",
            "PARSEG",
            "HLEVEL",
            "OCCMIN",
            "OCCMAX",
            "MUSTFL",
            "CIMTYP",
            "DOCTYP",
          ]),
          source: relSrc,
        });
      }
      if (idoctyp && cim) {
        emitRelation(relations, {
          relation_kind: "IDOC_TYPE_TO_EXTENSION",
          from_object_type: "idoc_type",
          from_object_id: idoctyp,
          to_object_type: "idoc_extension",
          to_object_id: cim,
          attributes: { via: "EDISYN" },
          source: relSrc,
        });
      }
      break;
    }
    case "EDPP1": {
      const id = keyOf(str(v.PARTYP), str(v.PARNUM));
      if (!id) break;
      emitObject(objects, {
        object_type: "partner_profile",
        object_id: id,
        display_name: str(v.PARNUM) || null,
        source: src,
        attributes: {
          direction: "header",
          ...pickAttrs(v, ["PARTYP", "PARNUM", "CLASS", "MATLVL"]),
        },
      });
      break;
    }
    case "EDP12": {
      const id = keyOf(
        str(v.RCVPRT),
        str(v.RCVPRN),
        str(v.RCVPFC),
        str(v.KAPPL),
        str(v.KSCHL),
        str(v.AENDE),
      );
      if (!id) break;
      emitObject(objects, {
        object_type: "partner_profile",
        object_id: id,
        display_name: str(v.RCVPRN) || null,
        source: src,
        attributes: {
          direction: "outbound_msg_ctl",
          ...pickAttrs(v, [
            "RCVPRT",
            "RCVPRN",
            "RCVPFC",
            "KAPPL",
            "KSCHL",
            "AENDE",
            "EVCODA",
            "MESTYP",
            "MESCOD",
            "MESFCT",
          ]),
        },
      });
      const mestyp = str(v.MESTYP);
      if (mestyp) {
        emitRelation(relations, {
          relation_kind: "PARTNER_TO_MESSAGE_TYPE",
          from_object_type: "partner_profile",
          from_object_id: id,
          to_object_type: "ale_message_type",
          to_object_id: mestyp,
          attributes: {},
          source: relSrc,
        });
      }
      const pfc = str(v.RCVPFC);
      if (pfc) {
        emitRelation(relations, {
          relation_kind: "OUTPUT_TYPE_TO_PARTNER_FUNCTION",
          from_object_type: "output_type",
          from_object_id: keyOf("B", str(v.KAPPL), str(v.KSCHL)),
          to_object_type: "external_technical",
          to_object_id: pfc,
          attributes: { partner_profile_id: id },
          source: relSrc,
        });
      }
      break;
    }
    case "EDP13": {
      const id = keyOf(
        str(v.RCVPRT),
        str(v.RCVPRN),
        str(v.RCVPFC),
        str(v.MESTYP),
        str(v.MESCOD),
        str(v.MESFCT),
      );
      if (!id) break;
      emitObject(objects, {
        object_type: "partner_profile",
        object_id: id,
        display_name: str(v.RCVPRN) || null,
        source: src,
        attributes: {
          direction: "outbound",
          ...pickAttrs(v, [
            "RCVPRT",
            "RCVPRN",
            "RCVPFC",
            "MESTYP",
            "MESCOD",
            "MESFCT",
            "IDOCTYP",
            "CIMTYP",
            "RCVPOR",
            "OUTMOD",
            "DOCTYP",
            "EDIVIEW",
            "SYNCHK",
          ]),
        },
      });
      const mestyp = str(v.MESTYP);
      if (mestyp) {
        emitRelation(relations, {
          relation_kind: "PARTNER_TO_MESSAGE_TYPE",
          from_object_type: "partner_profile",
          from_object_id: id,
          to_object_type: "ale_message_type",
          to_object_id: mestyp,
          attributes: {},
          source: relSrc,
        });
      }
      const idoctyp = str(v.IDOCTYP);
      if (idoctyp) {
        emitRelation(relations, {
          relation_kind: "PARTNER_TO_IDOC_TYPE",
          from_object_type: "partner_profile",
          from_object_id: id,
          to_object_type: "idoc_type",
          to_object_id: idoctyp,
          attributes: {},
          source: relSrc,
        });
      }
      const port = str(v.RCVPOR);
      if (port) {
        emitRelation(relations, {
          relation_kind: "PARTNER_TO_PORT",
          from_object_type: "partner_profile",
          from_object_id: id,
          to_object_type: "port",
          to_object_id: port,
          attributes: {},
          source: relSrc,
        });
      }
      break;
    }
    case "EDP21": {
      const id = keyOf(
        str(v.SNDPRT),
        str(v.SNDPRN),
        str(v.SNDPFC),
        str(v.MESTYP),
        str(v.MESCOD),
        str(v.MESFCT),
      );
      if (!id) break;
      emitObject(objects, {
        object_type: "partner_profile",
        object_id: id,
        display_name: str(v.SNDPRN) || null,
        source: src,
        attributes: {
          direction: "inbound",
          ...pickAttrs(v, [
            "SNDPRT",
            "SNDPRN",
            "SNDPFC",
            "MESTYP",
            "MESCOD",
            "MESFCT",
            "EVCODE",
            "INMOD",
            "SYNCHK",
            "METHOD",
          ]),
        },
      });
      const mestyp = str(v.MESTYP);
      if (mestyp) {
        emitRelation(relations, {
          relation_kind: "PARTNER_TO_MESSAGE_TYPE",
          from_object_type: "partner_profile",
          from_object_id: id,
          to_object_type: "ale_message_type",
          to_object_id: mestyp,
          attributes: { direction: "inbound" },
          source: relSrc,
        });
      }
      break;
    }
    case "TEDE1": {
      const id = keyOf("OUT", str(v.EVCODE));
      if (!str(v.EVCODE)) break;
      emitObject(objects, {
        object_type: "process_code",
        object_id: id,
        display_name: str(v.EVCODE),
        source: src,
        attributes: {
          direction: "outbound",
          ...pickAttrs(v, ["EVCODE", "ROUTID", "MESTYP", "EDIVRS", "INVERS"]),
        },
      });
      const rout = str(v.ROUTID);
      if (rout) {
        emitRelation(relations, {
          relation_kind: "PROCESS_CODE_TO_FUNCTION",
          from_object_type: "process_code",
          from_object_id: id,
          to_object_type: "external_technical",
          to_object_id: rout.toUpperCase(),
          attributes: { field: "ROUTID" },
          source: relSrc,
        });
      }
      break;
    }
    case "TEDE2": {
      const id = keyOf("IN", str(v.EVCODE));
      if (!str(v.EVCODE)) break;
      emitObject(objects, {
        object_type: "process_code",
        object_id: id,
        display_name: str(v.EVCODE),
        source: src,
        attributes: {
          direction: "inbound",
          ...pickAttrs(v, ["EVCODE"]),
        },
      });
      break;
    }
    case "TEDE3": {
      const id = keyOf("STA", str(v.STA_ID) || str(v.EVCODE));
      if (!id) break;
      emitObject(objects, {
        object_type: "process_code",
        object_id: id,
        display_name: id,
        source: src,
        attributes: {
          direction: "status",
          ...pickAttrs(v, ["STA_ID", "ROUTID", "EVCODE"]),
        },
      });
      break;
    }
    case "TBD52": {
      const id = keyOf(str(v.EVCODE));
      if (!id) break;
      emitObject(objects, {
        object_type: "process_code_function",
        object_id: id,
        display_name: str(v.FUNCNAME) || id,
        source: src,
        attributes: pickAttrs(v, ["EVCODE", "FUNCNAME"]),
      });
      const fn = str(v.FUNCNAME);
      if (fn) {
        emitRelation(relations, {
          relation_kind: "PROCESS_CODE_TO_FUNCTION",
          from_object_type: "process_code",
          from_object_id: keyOf("IN", id),
          to_object_type: "external_technical",
          to_object_id: fn.toUpperCase(),
          attributes: { field: "FUNCNAME" },
          source: relSrc,
        });
      }
      break;
    }
    case "EDIPORT": {
      const id = keyOf(str(v.PORT));
      if (!id) break;
      emitObject(objects, {
        object_type: "port",
        object_id: id,
        display_name: str(v.DESCRI) || id,
        source: src,
        attributes: pickAttrs(v, ["PORT", "PORTTYP", "DESCRI"]),
      });
      break;
    }
    case "EDIPOA":
    case "EDIPOD":
    case "EDIPOF": {
      const id = keyOf(str(v.PORT));
      if (!id) break;
      const attrs = pickAttrs(v);
      emitObject(objects, {
        object_type: "port",
        object_id: id,
        display_name: id,
        source: src,
        attributes: { ...attrs, _port_detail_table: t },
      });
      const fn = str(v.FUNCTION) || str(v.OUTPUTFUNC);
      if (fn) {
        emitRelation(relations, {
          relation_kind: "TECHNICAL_OBJECT_TO_FUNCTION_MODULE",
          from_object_type: "port",
          from_object_id: id,
          to_object_type: "external_technical",
          to_object_id: fn.toUpperCase(),
          attributes: { via: t },
          source: relSrc,
        });
      }
      break;
    }
    case "TBDLS": {
      const id = keyOf(str(v.LOGSYS));
      if (!id) break;
      emitObject(objects, {
        object_type: "logical_system",
        object_id: id,
        display_name: id,
        source: src,
        attributes: pickAttrs(v, ["LOGSYS"]),
      });
      break;
    }
    case "TBDLST": {
      const id = keyOf(str(v.LOGSYS), str(v.LANGU));
      if (!id) break;
      emitObject(objects, {
        object_type: "logical_system",
        object_id: str(v.LOGSYS),
        display_name: str(v.STEXT) || str(v.LOGSYS),
        source: src,
        attributes: {
          ...pickAttrs(v, ["LOGSYS", "LANGU", "STEXT"]),
          _text_id: id,
        },
      });
      break;
    }
    case "TBDME": {
      const id = keyOf(str(v.MESTYP));
      if (!id) break;
      emitObject(objects, {
        object_type: "ale_model_assignment",
        object_id: id,
        display_name: id,
        source: src,
        attributes: pickAttrs(v, [
          "MESTYP",
          "REFMESTYP",
          "IDOCFBNAME",
          "OBJTYPE",
          "OBTAB",
          "REDUCIBLE",
          "BDCP2_SUP",
        ]),
      });
      const fb = str(v.IDOCFBNAME);
      if (fb) {
        emitRelation(relations, {
          relation_kind: "TECHNICAL_OBJECT_TO_FUNCTION_MODULE",
          from_object_type: "ale_model_assignment",
          from_object_id: id,
          to_object_type: "external_technical",
          to_object_id: fb.toUpperCase(),
          attributes: { field: "IDOCFBNAME" },
          source: relSrc,
        });
      }
      break;
    }
    case "TBD62": {
      // High volume change-pointer field map — emit as ale_model_assignment detail attributes via relations only for MESTYP
      const mestyp = str(v.MESTYP);
      if (!mestyp) {
        unmapped.push({
          reason: "TBD62_without_mestyp",
          source_table: t,
          values: pickAttrs(v),
        });
        break;
      }
      const id = keyOf(
        str(v.CDOBJCL),
        mestyp,
        str(v.TABNAME),
        str(v.FLDNAME),
      );
      emitObject(objects, {
        object_type: "ale_model_assignment",
        object_id: `CP|${id}`,
        display_name: `${mestyp}:${str(v.TABNAME)}.${str(v.FLDNAME)}`,
        source: src,
        attributes: pickAttrs(v, [
          "CDOBJCL",
          "MESTYP",
          "TABNAME",
          "FLDNAME",
        ]),
      });
      break;
    }
    default:
      unmapped.push({
        reason: "no_mapper_for_source_table",
        source_table: t,
        config_group: ctx.configGroup,
        sample_fields: Object.keys(v).slice(0, 12),
      });
  }
}

async function streamFile(
  abs: string,
  meta: { fileName: string; configGroup: string | null },
  objects: Map<string, CanonicalObject>,
  relations: Map<string, CanonicalRelation>,
  unmapped: Array<Record<string, unknown>>,
  stats: { rows: number; byTable: Record<string, number> },
): Promise<void> {
  let systemId: string | null = null;
  let client: string | null = null;
  let configGroup = meta.configGroup ?? "UNKNOWN";

  const rl = createInterface({
    input: createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      const rt =
        typeof obj.record_type === "string"
          ? obj.record_type.trim().toLowerCase()
          : "";
      if (rt === "header") {
        systemId = str(obj.system_id) || null;
        client = str(obj.client) || null;
        if (typeof obj.config_group === "string") {
          configGroup = obj.config_group.trim();
        }
        continue;
      }
      if (rt !== "configuration_row") continue;
      const sourceTable = str(obj.source_table || obj.table_name).toUpperCase();
      if (!sourceTable) continue;
      const values =
        obj.values && typeof obj.values === "object" && !Array.isArray(obj.values)
          ? (obj.values as Record<string, unknown>)
          : {};
      stats.rows += 1;
      stats.byTable[sourceTable] = (stats.byTable[sourceTable] ?? 0) + 1;
      mapRow(
        {
          rawFile: meta.fileName,
          configGroup,
          sourceTable,
          systemId,
          client,
          values,
        },
        objects,
        relations,
        unmapped,
      );
    }
  } finally {
    rl.close();
  }
}

export type ConvertMessageIdocResult = {
  ok: boolean;
  message: string;
  object_counts: Record<string, number>;
  relation_counts: Record<string, number>;
  unmapped_count: number;
  zecd: {
    output_type: CanonicalObject | null;
    output_type_text: CanonicalObject | null;
    output_processing: CanonicalObject | null;
    relations: CanonicalRelation[];
  };
  paths: {
    objects: string;
    object_ids: string;
    relations: string;
    header: string;
    ingest_report: string;
    unmapped: string;
  };
};

export async function convertMessageIdocConfig(
  projectKey: string,
): Promise<ConvertMessageIdocResult> {
  const key = projectKey.trim() || "P01";
  ensureWritableDir(key, "canonical", "message-idoc-config");
  const files = detectMessageIdocRawFiles(key);
  const objects = new Map<string, CanonicalObject>();
  const relations = new Map<string, CanonicalRelation>();
  const unmapped: Array<Record<string, unknown>> = [];
  const stats = { rows: 0, byTable: {} as Record<string, number> };

  for (const f of files) {
    const abs = resolveRawPath(key, ...RAW_FOLDER_PARTS, f.fileName);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    await streamFile(
      abs,
      {
        fileName: f.fileName,
        configGroup: f.configGroupFromFileName,
      },
      objects,
      relations,
      unmapped,
      stats,
    );
  }

  const objectsPath = "message-idoc-config/objects.jsonl";
  const objectIdsPath = "message-idoc-config/object_ids.jsonl";
  const relationsPath = "message-idoc-config/relations.jsonl";
  const unmappedPath = "message-idoc-config/unmapped.jsonl";
  const headerPath = "message-idoc-config/header.json";
  const reportPath = "message-idoc-config/ingest_report.json";

  const absObjects = resolveWritablePath(key, "canonical", objectsPath);
  const absObjectIds = resolveWritablePath(key, "canonical", objectIdsPath);
  const absRelations = resolveWritablePath(key, "canonical", relationsPath);
  const absUnmapped = resolveWritablePath(key, "canonical", unmappedPath);

  const ow = createWriteStream(absObjects, { encoding: "utf8" });
  const idw = createWriteStream(absObjectIds, { encoding: "utf8" });
  for (const o of objects.values()) {
    ow.write(`${JSON.stringify(o)}\n`);
    idw.write(
      `${JSON.stringify({
        object_type: o.object_type,
        object_id: o.object_id,
        display_name: o.display_name,
        _canonical_key: o._canonical_key,
        source_table: o.source.source_table,
        config_group: o.source.config_group,
      })}\n`,
    );
  }
  ow.end();
  idw.end();
  await finished(ow);
  await finished(idw);

  const rw = createWriteStream(absRelations, { encoding: "utf8" });
  for (const r of relations.values()) {
    rw.write(`${JSON.stringify(r)}\n`);
  }
  rw.end();
  await finished(rw);

  const uw = createWriteStream(absUnmapped, { encoding: "utf8" });
  // Cap unmapped log
  for (const u of unmapped.slice(0, 5000)) {
    uw.write(`${JSON.stringify(u)}\n`);
  }
  uw.end();
  await finished(uw);

  const object_counts: Record<string, number> = {};
  for (const o of objects.values()) {
    object_counts[o.object_type] = (object_counts[o.object_type] ?? 0) + 1;
  }
  const relation_counts: Record<string, number> = {};
  for (const r of relations.values()) {
    relation_counts[r.relation_kind] =
      (relation_counts[r.relation_kind] ?? 0) + 1;
  }

  const zecdOt =
    [...objects.values()].find(
      (o) =>
        o.object_type === "output_type" &&
        String(o.attributes.KSCHL ?? "").toUpperCase() === "ZECD",
    ) ?? null;
  const zecdText =
    [...objects.values()].find(
      (o) =>
        o.object_type === "output_type_text" &&
        String(o.attributes.KSCHL ?? "").toUpperCase() === "ZECD",
    ) ?? null;
  const zecdProc =
    [...objects.values()].find(
      (o) =>
        o.object_type === "output_processing" &&
        String(o.attributes.KSCHL ?? "").toUpperCase() === "ZECD",
    ) ?? null;
  const zecdRels = [...relations.values()].filter(
    (r) =>
      (zecdOt && r.from_object_id === zecdOt.object_id) ||
      (zecdProc && r.from_object_id === zecdProc.object_id) ||
      String(r.to_object_id).includes("ZECD") ||
      String(r.from_object_id).includes("ZECD"),
  );

  const header = {
    schema_version: 1,
    pipeline_type: "MESSAGE_IDOC_CONFIG",
    project: key,
    converted_at: new Date().toISOString(),
    expected_groups: CONFIG_GROUPS.length,
    files: files.map((f) => f.fileName),
    expected_source_tables: EXPECTED_SOURCE_TABLES,
    excluded_attribute_fields: [...EXCLUDE_FIELDS],
  };
  writeGeneratedText(
    key,
    "canonical",
    headerPath,
    `${JSON.stringify(header, null, 2)}\n`,
  );

  const report = {
    ...header,
    configuration_rows_read: stats.rows,
    rows_by_source_table: stats.byTable,
    object_counts,
    relation_counts,
    objects_total: objects.size,
    relations_total: relations.size,
    unmapped_count: unmapped.length,
    zecd_present: Boolean(zecdOt),
    zecd: {
      output_type_id: zecdOt?.object_id ?? null,
      text: zecdText?.display_name ?? null,
      program: zecdProc?.attributes?.PGNAM ?? null,
      routine: zecdProc?.attributes?.RONAM ?? null,
      nacha: zecdProc?.attributes?.NACHA ?? null,
    },
  };
  writeGeneratedText(
    key,
    "canonical",
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );

  // Also copy ingest report under logs for UI
  writeGeneratedText(
    key,
    "logs",
    "message-idoc-config/convert-report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  return {
    ok: true,
    message: `Canonical: ${objects.size} Objekte, ${relations.size} Relationen`,
    object_counts,
    relation_counts,
    unmapped_count: unmapped.length,
    zecd: {
      output_type: zecdOt,
      output_type_text: zecdText,
      output_processing: zecdProc,
      relations: zecdRels,
    },
    paths: {
      objects: `canonical/${objectsPath}`,
      object_ids: `canonical/${objectIdsPath}`,
      relations: `canonical/${relationsPath}`,
      header: `canonical/${headerPath}`,
      ingest_report: `canonical/${reportPath}`,
      unmapped: `canonical/${unmappedPath}`,
    },
  };
}
