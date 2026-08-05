/**
 * Domain configs for master-data pipelines (customers / vendors / …).
 * Filename is hint only — header table_name + export_type is authoritative.
 */

export type MasterDataFileKind = "structure" | "content";

export type MasterDataRelationDef = {
  id: string;
  kind: "central" | "parent_child";
  from_table: string;
  to_table: string | null;
  /** Join / identity keys observed on CONTENT values (no invented PII). */
  keys: readonly string[];
  description: string;
};

export type MasterDataDomainConfig = {
  /** Export type id in exportTypeConfig (customers | vendors). */
  exportTypeId: string;
  /** Human label for logs/summaries. */
  label: string;
  setToken: string;
  tables: readonly string[];
  rawParts: readonly string[];
  canonicalRel: string;
  logParts: readonly string[];
  logFileName: string;
  /** Expected header.profile when known (CUSTOMER | VENDOR). */
  expectedProfile: string | null;
  /** values{} keys used for fallback canonical identity. */
  contentKeyFields: readonly string[];
  /** Per-table key fields (metadata / relations). */
  tableKeyFields: Readonly<Record<string, readonly string[]>>;
  relations: readonly MasterDataRelationDef[];
  /** Optional filename hint — never authoritative. */
  filenameHint: RegExp | null;
};

/** Customers: KNA1, KNVV, KNVP, KNVH × STRUCTURE+CONTENT. */
export const CUSTOMERS_DOMAIN: MasterDataDomainConfig = {
  exportTypeId: "customers",
  label: "Kundenstammdaten",
  setToken: "__CUSTOMERS_SET__",
  tables: ["KNA1", "KNVV", "KNVP", "KNVH"],
  rawParts: ["master-data", "customers"],
  canonicalRel: "master-data/customers",
  logParts: ["datenbasis", "customers"],
  logFileName: "datenbasis-customers.log",
  expectedProfile: "CUSTOMER",
  contentKeyFields: [
    "KUNNR",
    "VKORG",
    "VTWEG",
    "SPART",
    "PARVW",
    "PARZA",
    "HITYP",
    "DATAB",
    "HKUNNR",
  ],
  tableKeyFields: {
    KNA1: ["KUNNR"],
    KNVV: ["KUNNR", "VKORG", "VTWEG", "SPART"],
    KNVP: ["KUNNR", "VKORG", "VTWEG", "SPART", "PARVW", "PARZA"],
    KNVH: ["HITYP", "KUNNR", "VKORG", "VTWEG", "SPART", "DATAB"],
  },
  relations: [
    {
      id: "kna1_central",
      kind: "central",
      from_table: "KNA1",
      to_table: null,
      keys: ["KUNNR"],
      description: "Zentraler Kundenstamm (KNA1)",
    },
    {
      id: "kna1_to_knvv",
      kind: "parent_child",
      from_table: "KNA1",
      to_table: "KNVV",
      keys: ["KUNNR"],
      description: "Kunde → Vertriebsbereich (KNA1→KNVV)",
    },
    {
      id: "knvv_to_knvp",
      kind: "parent_child",
      from_table: "KNVV",
      to_table: "KNVP",
      keys: ["KUNNR", "VKORG", "VTWEG", "SPART"],
      description: "Vertriebsbereich → Partnerrollen (KNVV→KNVP)",
    },
    {
      id: "knvv_to_knvh",
      kind: "parent_child",
      from_table: "KNVV",
      to_table: "KNVH",
      keys: ["KUNNR", "VKORG", "VTWEG", "SPART"],
      description: "Vertriebsbereich → Hierarchie (KNVV→KNVH)",
    },
    {
      id: "kna1_to_knvh",
      kind: "parent_child",
      from_table: "KNA1",
      to_table: "KNVH",
      keys: ["KUNNR"],
      description: "Kunde → Hierarchie (KNA1→KNVH)",
    },
  ],
  filenameHint: /_CUSTOMER_(KNA1|KNVV|KNVP|KNVH)_(CONTENT|STRUCTURE)\.jsonl$/i,
};

/** Vendors: LFA1, LFM1 × STRUCTURE+CONTENT. */
export const VENDORS_DOMAIN: MasterDataDomainConfig = {
  exportTypeId: "vendors",
  label: "Lieferantenstammdaten",
  setToken: "__VENDORS_SET__",
  tables: ["LFA1", "LFM1"],
  rawParts: ["master-data", "vendors"],
  canonicalRel: "master-data/vendors",
  logParts: ["datenbasis", "vendors"],
  logFileName: "datenbasis-vendors.log",
  expectedProfile: "VENDOR",
  contentKeyFields: ["LIFNR", "EKORG"],
  tableKeyFields: {
    LFA1: ["LIFNR"],
    LFM1: ["LIFNR", "EKORG"],
  },
  relations: [
    {
      id: "lfa1_central",
      kind: "central",
      from_table: "LFA1",
      to_table: null,
      keys: ["LIFNR"],
      description: "Zentraler Lieferantenstamm (LFA1)",
    },
    {
      id: "lfa1_to_lfm1",
      kind: "parent_child",
      from_table: "LFA1",
      to_table: "LFM1",
      keys: ["LIFNR"],
      description: "Lieferant → Einkaufsorganisation (LFA1→LFM1)",
    },
  ],
  filenameHint: /_VENDOR_(LFA1|LFM1)_(CONTENT|STRUCTURE)\.jsonl$/i,
};
