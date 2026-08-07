/**
 * Link partner profile numbers to customer/vendor master keys.
 * Normalizes leading zeros; keeps original value. No names/addresses.
 */
import { existsSync } from "fs";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import {
  asString,
  streamJsonlObjects,
} from "@/lib/knowledge/multiSourceSearch/streamJsonl";
import type { EvidenceGraphEdge, EvidenceGraphNode } from "./types";

export type PartnerMasterMatch = {
  partner_object_id: string;
  partner_type: string;
  partner_number_raw: string;
  partner_number_normalized: string;
  match_kind: "customer" | "vendor" | "unresolved" | "ambiguous";
  matched_keys: string[];
  relation:
    | "PARTNER_NUMBER_MATCHES_CUSTOMER"
    | "PARTNER_NUMBER_MATCHES_VENDOR"
    | null;
};

export type PartnerMasterResult = {
  matches: PartnerMasterMatch[];
  unresolved: PartnerMasterMatch[];
  ambiguous: PartnerMasterMatch[];
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
};

/** Customer-like partner types (SAP PARTYP / RCVPRT). */
const CUSTOMER_TYPES = new Set([
  "KU",
  "KUN",
  "AG",
  "WE",
  "RE",
  "RG",
  "SP",
  "AP",
]);
/** Vendor-like partner types. */
const VENDOR_TYPES = new Set(["LI", "LF", "LIE", "YL", "IP"]);

function normalizePartnerNumber(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  // Keep alphanumeric; strip spaces
  const cleaned = t.replace(/\s+/g, "");
  // Numeric: strip leading zeros but keep at least one digit
  if (/^\d+$/.test(cleaned)) {
    const stripped = cleaned.replace(/^0+/, "");
    return stripped.length ? stripped : "0";
  }
  return cleaned.toUpperCase();
}

function padSapKey(norm: string, width = 10): string {
  if (!/^\d+$/.test(norm)) return norm;
  return norm.padStart(width, "0");
}

type MasterIndex = {
  customers: Map<string, string>; // normalized → canonical KUNNR
  vendors: Map<string, string>;
};

let cache: { projectKey: string; index: MasterIndex } | null = null;

async function loadMasterIndex(projectKey: string): Promise<MasterIndex> {
  if (cache?.projectKey === projectKey) return cache.index;
  const customers = new Map<string, string>();
  const vendors = new Map<string, string>();

  const loadTable = async (
    domain: "customers" | "vendors",
    table: string,
    field: "KUNNR" | "LIFNR",
    target: Map<string, string>,
  ) => {
    const abs = resolveProjectZonePath(
      projectKey,
      "canonical",
      "master-data",
      domain,
      table,
      "content.jsonl",
    );
    if (!existsSync(abs)) return;
    let n = 0;
    for await (const rec of streamJsonlObjects(abs)) {
      if (n++ > 500_000) break;
      if (asString(rec.record_type) !== "master_data_row") continue;
      const values =
        rec.values && typeof rec.values === "object"
          ? (rec.values as Record<string, unknown>)
          : {};
      const raw = String(values[field] ?? "").trim();
      if (!raw) continue;
      const norm = normalizePartnerNumber(raw);
      if (!norm) continue;
      if (!target.has(norm)) target.set(norm, raw);
      // also index padded form
      const padded = padSapKey(norm);
      if (!target.has(padded)) target.set(padded, raw);
    }
  };

  await loadTable("customers", "KNA1", "KUNNR", customers);
  await loadTable("vendors", "LFA1", "LIFNR", vendors);

  const index = { customers, vendors };
  cache = { projectKey, index };
  return index;
}

function classifyPartnerType(partyp: string): "customer" | "vendor" | "unknown" {
  const t = partyp.trim().toUpperCase();
  if (CUSTOMER_TYPES.has(t)) return "customer";
  if (VENDOR_TYPES.has(t)) return "vendor";
  // Heuristic: starts with KU → customer, LI → vendor
  if (t.startsWith("KU") || t === "K") return "customer";
  if (t.startsWith("LI") || t.startsWith("LF")) return "vendor";
  return "unknown";
}

function lookupKeys(
  index: Map<string, string>,
  raw: string,
): string[] {
  const norm = normalizePartnerNumber(raw);
  const keys = new Set<string>();
  for (const cand of [norm, padSapKey(norm), padSapKey(norm, 10), raw.trim()]) {
    const hit = index.get(cand) ?? index.get(normalizePartnerNumber(cand));
    if (hit) keys.add(hit);
  }
  // Also try matching by scanning normalized equality
  if (keys.size === 0 && norm) {
    const hit = index.get(norm);
    if (hit) keys.add(hit);
  }
  return [...keys];
}

export async function resolvePartnerToMaster(params: {
  projectKey: string;
  partners: Array<{
    object_id: string;
    partner_type?: string;
    partner_number?: string;
    attributes?: Record<string, unknown>;
  }>;
}): Promise<PartnerMasterResult> {
  const index = await loadMasterIndex(params.projectKey);
  const matches: PartnerMasterMatch[] = [];
  const unresolved: PartnerMasterMatch[] = [];
  const ambiguous: PartnerMasterMatch[] = [];
  const nodes: EvidenceGraphNode[] = [];
  const edges: EvidenceGraphEdge[] = [];

  for (const p of params.partners) {
    const attrs = p.attributes ?? {};
    const partyp = (
      p.partner_type ||
      asString(attrs.PARTYP) ||
      asString(attrs.RCVPRT) ||
      asString(attrs.SNDPRT) ||
      ""
    ).trim();
    const parnum = (
      p.partner_number ||
      asString(attrs.PARNUM) ||
      asString(attrs.RCVPRN) ||
      asString(attrs.SNDPRN) ||
      ""
    ).trim();
    if (!parnum) continue;

    const kind = classifyPartnerType(partyp);
    const norm = normalizePartnerNumber(parnum);
    const customerKeys = lookupKeys(index.customers, parnum);
    const vendorKeys = lookupKeys(index.vendors, parnum);

    let match_kind: PartnerMasterMatch["match_kind"] = "unresolved";
    let matched_keys: string[] = [];
    let relation: PartnerMasterMatch["relation"] = null;

    if (kind === "customer") {
      matched_keys = customerKeys;
      if (matched_keys.length === 1) {
        match_kind = "customer";
        relation = "PARTNER_NUMBER_MATCHES_CUSTOMER";
      } else if (matched_keys.length > 1) match_kind = "ambiguous";
    } else if (kind === "vendor") {
      matched_keys = vendorKeys;
      if (matched_keys.length === 1) {
        match_kind = "vendor";
        relation = "PARTNER_NUMBER_MATCHES_VENDOR";
      } else if (matched_keys.length > 1) match_kind = "ambiguous";
    } else {
      // Unknown type: try both; ambiguous if both hit
      if (customerKeys.length === 1 && vendorKeys.length === 0) {
        matched_keys = customerKeys;
        match_kind = "customer";
        relation = "PARTNER_NUMBER_MATCHES_CUSTOMER";
      } else if (vendorKeys.length === 1 && customerKeys.length === 0) {
        matched_keys = vendorKeys;
        match_kind = "vendor";
        relation = "PARTNER_NUMBER_MATCHES_VENDOR";
      } else if (customerKeys.length + vendorKeys.length > 1) {
        matched_keys = [...customerKeys, ...vendorKeys];
        match_kind = "ambiguous";
      }
    }

    const row: PartnerMasterMatch = {
      partner_object_id: p.object_id,
      partner_type: partyp || "?",
      partner_number_raw: parnum,
      partner_number_normalized: norm,
      match_kind,
      matched_keys,
      relation,
    };

    if (match_kind === "unresolved") unresolved.push(row);
    else if (match_kind === "ambiguous") ambiguous.push(row);
    else matches.push(row);

    const partnerNodeId = `node:PARTNER_PROFILE:${p.object_id}`;
    nodes.push({
      id: partnerNodeId,
      type: "PARTNER_PROFILE",
      name: parnum,
      source: "partner_master_resolution",
      source_path: "canonical/message-idoc-config/objects.jsonl",
      exact_match: true,
      score: 0.9,
      attributes: {
        PARTYP: partyp,
        PARNUM: parnum,
        PARNUM_NORMALIZED: norm,
        match_kind,
      },
    });

    if (relation && matched_keys.length === 1) {
      const masterKey = matched_keys[0]!;
      const masterType =
        relation === "PARTNER_NUMBER_MATCHES_CUSTOMER"
          ? "MASTER_DATA_ENTITY"
          : "MASTER_DATA_ENTITY";
      const masterId = `node:${masterType}:${relation === "PARTNER_NUMBER_MATCHES_CUSTOMER" ? "KUNNR" : "LIFNR"}:${masterKey}`;
      nodes.push({
        id: masterId,
        type: "MASTER_DATA_ENTITY",
        name: masterKey,
        source: "partner_master_resolution",
        source_path:
          relation === "PARTNER_NUMBER_MATCHES_CUSTOMER"
            ? "canonical/master-data/customers/KNA1/content.jsonl"
            : "canonical/master-data/vendors/LFA1/content.jsonl",
        exact_match: true,
        score: 0.95,
        attributes: {
          entity_type:
            relation === "PARTNER_NUMBER_MATCHES_CUSTOMER"
              ? "customer_number"
              : "vendor_number",
          key_field:
            relation === "PARTNER_NUMBER_MATCHES_CUSTOMER" ? "KUNNR" : "LIFNR",
          key_value: masterKey,
          partner_number_raw: parnum,
        },
      });
      edges.push({
        from: partnerNodeId,
        relation,
        to: masterId,
        resolution: "RESOLVED_STATIC",
        evidence: [
          `PARTYP=${partyp}`,
          `PARNUM_raw=${parnum}`,
          `PARNUM_norm=${norm}`,
          `matched=${masterKey}`,
        ],
        confidence: 0.92,
      });
    }
  }

  return { matches, unresolved, ambiguous, nodes, edges };
}

/**
 * Collect partner profile objects related to technical anchors (e.g. via KSCHL).
 */
export async function collectPartnerProfilesForAnchors(params: {
  projectKey: string;
  anchors: string[];
  maxPartners?: number;
}): Promise<
  Array<{
    object_id: string;
    attributes: Record<string, unknown>;
  }>
> {
  const abs = resolveProjectZonePath(
    params.projectKey,
    "canonical",
    "message-idoc-config",
    "objects.jsonl",
  );
  if (!existsSync(abs) || params.anchors.length === 0) return [];
  const needles = params.anchors.map((a) => a.toUpperCase());
  const out: Array<{ object_id: string; attributes: Record<string, unknown> }> =
    [];
  const max = params.maxPartners ?? 80;
  for await (const rec of streamJsonlObjects(abs)) {
    if (asString(rec.object_type) !== "partner_profile") continue;
    const objectId = asString(rec.object_id);
    const attrs =
      rec.attributes && typeof rec.attributes === "object"
        ? (rec.attributes as Record<string, unknown>)
        : {};
    const blob = `${objectId} ${JSON.stringify(attrs)}`.toUpperCase();
    if (!needles.some((n) => blob.includes(n))) continue;
    out.push({ object_id: objectId, attributes: attrs });
    if (out.length >= max) break;
  }
  return out;
}
