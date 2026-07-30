/**
 * Pipeline step catalog — orchestration metadata only.
 * Handlers map to existing npm scripts; business logic stays in adapters.
 */

export type PipelineStepId =
  | "canonicalize.sap_classes"
  | "analyze.sap_code_units"
  | "index.search_documents"
  | "index.search"
  | "canonicalize.control_tables"
  | "link.code_control_tables"
  | "analyze.control_tables"
  | "interpret.code_table";

export type PipelineStepDefinition = {
  id: PipelineStepId;
  title: string;
  description: string;
  /** npm script name in package.json (existing). */
  npm_script: string | null;
  /** Adapter family — not a customer name. */
  adapter: "sap" | "generic";
  requires_openai: boolean;
  idempotent: boolean;
  prompt_ids: string[];
  inputs: string[];
  outputs: string[];
  /** If true, CLI will not run unless --step matches exactly. */
  explicit_only: boolean;
  status: "active" | "reserved";
};

export const PIPELINE_STEPS: readonly PipelineStepDefinition[] = [
  {
    id: "canonicalize.sap_classes",
    title: "SAP-Klassen kanonisieren",
    description: "raw/classes → canonical/classes",
    npm_script: "canonicalize:sap-classes",
    adapter: "sap",
    requires_openai: false,
    idempotent: true,
    prompt_ids: [],
    inputs: ["raw/classes"],
    outputs: ["canonical/classes"],
    explicit_only: false,
    status: "active",
  },
  {
    id: "analyze.sap_code_units",
    title: "Code-Units analysieren",
    description: "canonical code_units → unit_analyses (OpenAI)",
    npm_script: "analyze:sap-code-units",
    adapter: "sap",
    requires_openai: true,
    idempotent: true,
    prompt_ids: ["unit_analysis"],
    inputs: ["canonical/classes/code_units.jsonl"],
    outputs: ["analyses/classes/unit_analyses.jsonl"],
    explicit_only: true,
    status: "active",
  },
  {
    id: "index.search_documents",
    title: "SearchDocuments indexieren",
    description: "analyses → indexes/search_documents",
    npm_script: "index:search-documents",
    adapter: "generic",
    requires_openai: false,
    idempotent: true,
    prompt_ids: [],
    inputs: ["analyses/classes/unit_analyses.jsonl"],
    outputs: ["indexes/classes/search_documents.jsonl"],
    explicit_only: false,
    status: "active",
  },
  {
    id: "index.search",
    title: "Hybrid-Search Index (Dokumente+Embeddings)",
    description:
      "code/table/rule/dynamic → indexes/search + embeddings/search",
    npm_script: "index:search",
    adapter: "generic",
    requires_openai: true,
    idempotent: true,
    prompt_ids: [],
    inputs: [
      "analyses/classes/unit_analyses.jsonl",
      "analyses/control-tables/table_analyses.jsonl",
      "analyses/relations/code_table_interpretations.jsonl",
      "canonical/control-tables/table_rows.jsonl",
    ],
    outputs: [
      "indexes/search/search_documents.jsonl",
      "embeddings/search/search_embeddings.jsonl",
      "indexes/search/index_manifest.json",
    ],
    explicit_only: true,
    status: "active",
  },
  {
    id: "canonicalize.control_tables",
    title: "Steuertabellen kanonisieren",
    description: "raw/control-tables → canonical/control-tables",
    npm_script: "canonicalize:control-tables",
    adapter: "sap",
    requires_openai: false,
    idempotent: true,
    prompt_ids: [],
    inputs: ["raw/control-tables"],
    outputs: ["canonical/control-tables"],
    explicit_only: false,
    status: "active",
  },
  {
    id: "link.code_control_tables",
    title: "Code↔Steuertabellen verknüpfen",
    description: "Deterministische Relationen code_units ↔ table_rows",
    npm_script: "link:code-control-tables",
    adapter: "sap",
    requires_openai: false,
    idempotent: true,
    prompt_ids: [],
    inputs: [
      "canonical/classes/code_units.jsonl",
      "canonical/control-tables",
    ],
    outputs: ["canonical/relations/code_table_links.jsonl"],
    explicit_only: false,
    status: "active",
  },
  {
    id: "analyze.control_tables",
    title: "Steuertabellen KI-Analyse",
    description: "Reserved — separate pilot; not auto-started",
    npm_script: null,
    adapter: "sap",
    requires_openai: true,
    idempotent: true,
    prompt_ids: ["control_table_analysis"],
    inputs: ["canonical/control-tables"],
    outputs: ["analyses/control-tables/table_analyses.jsonl"],
    explicit_only: true,
    status: "reserved",
  },
  {
    id: "interpret.code_table",
    title: "Code+Tabelle gemeinsam interpretieren",
    description: "Reserved — separate pilot; not auto-started",
    npm_script: null,
    adapter: "sap",
    requires_openai: true,
    idempotent: true,
    prompt_ids: ["code_table_interpretation"],
    inputs: ["canonical/relations/code_table_links.jsonl"],
    outputs: ["analyses/relations/code_table_interpretations.jsonl"],
    explicit_only: true,
    status: "reserved",
  },
] as const;

export function getPipelineStep(id: string): PipelineStepDefinition {
  const step = PIPELINE_STEPS.find((s) => s.id === id);
  if (!step) {
    throw new Error(
      `Unbekannter Pipeline-Step: ${id}. Bekannt: ${PIPELINE_STEPS.map((s) => s.id).join(", ")}`,
    );
  }
  return step;
}

export function listPipelineSteps(opts?: {
  includeReserved?: boolean;
}): PipelineStepDefinition[] {
  return PIPELINE_STEPS.filter(
    (s) => opts?.includeReserved || s.status === "active",
  );
}
