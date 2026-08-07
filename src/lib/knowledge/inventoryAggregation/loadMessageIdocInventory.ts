/**
 * Load message-idoc canonical objects + relations for inventory.
 */
import { existsSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import { streamJsonlObjects } from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import { messageIdocObjectIsAuthoritativeOutputType } from "@/lib/domain/typeAuthority";

export type LoadedOutputType = {
  application: string;
  output_type: string;
  kvewe: string;
  object_id: string;
  source_table: string;
  source_path: string;
};

export type LoadedOutputText = {
  application: string;
  output_type: string;
  language: string;
  text: string;
  source_path: string;
};

export type LoadedProcessing = {
  application: string;
  output_type: string;
  medium: string;
  program: string | null;
  routine: string | null;
  form: string | null;
  object_id: string;
  source_table: string;
  source_path: string;
};

export type LoadedRelation11 = {
  from_type: string;
  from_name: string;
  relation_type: string;
  to_type: string;
  to_name: string;
  programs: string[];
  routines: string[];
  applications: string[];
  partner_profiles: string[];
  source_path: string;
};

export type MessageIdocInventoryCorpus = {
  output_types: LoadedOutputType[];
  texts: LoadedOutputText[];
  processing: LoadedProcessing[];
  relations11: LoadedRelation11[];
  message_to_idoc: Array<{
    message_type: string;
    idoc_type: string;
    via: "USES_IDOC_TYPE" | "USES_IDOC_TYPE_IN_PROFILE" | "MESSAGE_TYPE_TO_IDOC_TYPE";
    source_path: string;
  }>;
  message_to_extension: Array<{
    message_type: string;
    extension: string;
    via: string;
    source_path: string;
  }>;
  partner_to_message: Array<{
    partner: string;
    message_type: string;
    source_path: string;
  }>;
  sources_present: string[];
};

function attr(obj: Record<string, unknown>, key: string): string {
  const a = obj.attributes;
  if (!a || typeof a !== "object" || Array.isArray(a)) return "";
  const v = (a as Record<string, unknown>)[key];
  if (v == null) return "";
  return String(v).trim();
}

function objectType(obj: Record<string, unknown>): string {
  return String(obj.object_type ?? "").trim().toLowerCase();
}

export async function loadMessageIdocInventoryCorpus(
  projectKey: string,
): Promise<MessageIdocInventoryCorpus> {
  const objectsAbs = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
    "objects.jsonl",
  );
  const relationsAbs = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
    "relations.jsonl",
  );
  const relations0110Abs = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
    "relations.from-groups-01-10.jsonl",
  );

  const sources_present: string[] = [];
  const output_types: LoadedOutputType[] = [];
  const texts: LoadedOutputText[] = [];
  const processing: LoadedProcessing[] = [];

  if (existsSync(objectsAbs)) {
    sources_present.push("canonical/message-idoc-config/objects.jsonl");
    for await (const obj of streamJsonlObjects(objectsAbs)) {
      const ot = objectType(obj);
      const attrs = (obj.attributes ?? {}) as Record<string, unknown>;
      if (ot === "output_type") {
        if (
          !messageIdocObjectIsAuthoritativeOutputType({
            object_type: ot,
            attributes: attrs,
          })
        ) {
          continue;
        }
        const application = attr(obj, "KAPPL");
        const output_type = attr(obj, "KSCHL");
        if (!application || !output_type) continue;
        output_types.push({
          application,
          output_type,
          kvewe: attr(obj, "KVEWE") || "B",
          object_id: String(obj.object_id ?? ""),
          source_table: String(
            (obj.source as { source_table?: string } | undefined)
              ?.source_table ?? "T685",
          ),
          source_path: "canonical/message-idoc-config/objects.jsonl",
        });
      } else if (ot === "output_type_text") {
        if (
          !messageIdocObjectIsAuthoritativeOutputType({
            object_type: ot,
            attributes: attrs,
          })
        ) {
          continue;
        }
        const application = attr(obj, "KAPPL");
        const output_type = attr(obj, "KSCHL");
        const text = attr(obj, "VTEXT");
        if (!application || !output_type || !text) continue;
        texts.push({
          application,
          output_type,
          language: attr(obj, "SPRAS") || "",
          text,
          source_path: "canonical/message-idoc-config/objects.jsonl",
        });
      } else if (ot === "output_processing") {
        const application = attr(obj, "KAPPL");
        const output_type = attr(obj, "KSCHL");
        if (!application || !output_type) continue;
        processing.push({
          application,
          output_type,
          medium: attr(obj, "NACHA"),
          program: attr(obj, "PGNAM") || null,
          routine: attr(obj, "RONAM") || null,
          form: attr(obj, "FONAM") || attr(obj, "SFORM") || null,
          object_id: String(obj.object_id ?? ""),
          source_table: String(
            (obj.source as { source_table?: string } | undefined)
              ?.source_table ?? "TNAPR",
          ),
          source_path: "canonical/message-idoc-config/objects.jsonl",
        });
      }
    }
  }

  const relations11: LoadedRelation11[] = [];
  const message_to_idoc: MessageIdocInventoryCorpus["message_to_idoc"] = [];
  const message_to_extension: MessageIdocInventoryCorpus["message_to_extension"] =
    [];
  const partner_to_message: MessageIdocInventoryCorpus["partner_to_message"] =
    [];

  async function ingestRelations(
    abs: string,
    pathHint: string,
    mode: "11" | "01-10",
  ) {
    if (!existsSync(abs)) return;
    sources_present.push(pathHint);
    for await (const obj of streamJsonlObjects(abs)) {
      if (mode === "11") {
        const from_type = String(obj.from_type ?? "").trim();
        const to_type = String(obj.to_type ?? "").trim();
        const relation_type = String(obj.relation_type ?? "").trim();
        const from_name = String(obj.from_name ?? "").trim();
        const to_name = String(obj.to_name ?? "").trim();
        if (!from_type || !relation_type || !to_type) continue;
        const ctx = (obj.contexts ?? {}) as Record<string, unknown>;
        relations11.push({
          from_type,
          from_name,
          relation_type,
          to_type,
          to_name,
          programs: Array.isArray(ctx.programs)
            ? ctx.programs.map(String)
            : [],
          routines: Array.isArray(ctx.routines)
            ? ctx.routines.map(String)
            : [],
          applications: Array.isArray(ctx.applications)
            ? ctx.applications.map(String)
            : [],
          partner_profiles: Array.isArray(ctx.partner_profiles)
            ? ctx.partner_profiles.map(String)
            : [],
          source_path: pathHint,
        });
        if (
          from_type === "MESSAGE_TYPE" &&
          (relation_type === "USES_IDOC_TYPE" ||
            relation_type === "USES_IDOC_TYPE_IN_PROFILE") &&
          to_type === "IDOC_TYPE"
        ) {
          message_to_idoc.push({
            message_type: from_name,
            idoc_type: to_name,
            via: relation_type,
            source_path: pathHint,
          });
        }
        if (
          from_type === "MESSAGE_TYPE" &&
          (relation_type === "USES_IDOC_EXTENSION" ||
            relation_type === "USES_IDOC_EXTENSION_IN_PROFILE") &&
          to_type === "IDOC_EXTENSION"
        ) {
          message_to_extension.push({
            message_type: from_name,
            extension: to_name,
            via: relation_type,
            source_path: pathHint,
          });
        }
        if (
          from_type === "PARTNER_PROFILE" &&
          relation_type === "CONFIGURES_MESSAGE_TYPE" &&
          to_type === "MESSAGE_TYPE"
        ) {
          partner_to_message.push({
            partner: from_name,
            message_type: to_name,
            source_path: pathHint,
          });
        }
      } else {
        const kind = String(obj.relation_kind ?? "").trim();
        const fromOt = String(obj.from_object_type ?? "").trim();
        const toOt = String(obj.to_object_type ?? "").trim();
        const fromId = String(obj.from_object_id ?? "").trim();
        const toId = String(obj.to_object_id ?? "").trim();
        if (kind === "MESSAGE_TYPE_TO_IDOC_TYPE") {
          // from may be ale_message_type id = MSGTYP
          message_to_idoc.push({
            message_type: fromId,
            idoc_type: toId,
            via: "MESSAGE_TYPE_TO_IDOC_TYPE",
            source_path: pathHint,
          });
        }
        if (
          kind === "PARTNER_TO_MESSAGE_TYPE" &&
          fromOt === "partner_profile"
        ) {
          partner_to_message.push({
            partner: fromId,
            message_type: toId,
            source_path: pathHint,
          });
        }
        if (kind === "IDOC_TYPE_TO_EXTENSION") {
          message_to_extension.push({
            message_type: fromId,
            extension: toId,
            via: kind,
            source_path: pathHint,
          });
        }
      }
    }
  }

  await ingestRelations(
    relationsAbs,
    "canonical/message-idoc-config/relations.jsonl",
    "11",
  );
  // Prefer 11 for OUTPUT edges; still merge 01-10 assignments if 11 missing those
  if (existsSync(relations0110Abs)) {
    await ingestRelations(
      relations0110Abs,
      "canonical/message-idoc-config/relations.from-groups-01-10.jsonl",
      "01-10",
    );
  }

  return {
    output_types,
    texts,
    processing,
    relations11,
    message_to_idoc,
    message_to_extension,
    partner_to_message,
    sources_present,
  };
}
