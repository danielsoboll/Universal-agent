import { existsSync, readFileSync } from "fs";
import path from "path";
import { z } from "zod";

export const customerSystemSchema = z.object({
  system_id: z.string().min(1),
  label: z.string().default(""),
  /** Optional hint; never used as a hardcoded business rule in core. */
  notes: z.string().optional(),
});

export const customerPathsSchema = z.object({
  raw_classes: z.string().default("raw/classes"),
  raw_control_tables_definitions: z
    .string()
    .default("raw/control-tables/definitions"),
  raw_control_tables_contents: z
    .string()
    .default("raw/control-tables/contents"),
  canonical_classes: z.string().default("canonical/classes"),
  canonical_control_tables: z.string().default("canonical/control-tables"),
  canonical_relations: z.string().default("canonical/relations"),
  analyses_classes: z.string().default("analyses/classes"),
  analyses_control_tables: z.string().default("analyses/control-tables"),
  analyses_relations: z.string().default("analyses/relations"),
  indexes_classes: z.string().default("indexes/classes"),
  logs: z.string().default("logs"),
  runs: z.string().default("logs/runs"),
});

export const customerPipelineDefaultsSchema = z.object({
  /** Prompt version pins — must match prompt registry ids. */
  prompt_versions: z
    .record(z.string(), z.string())
    .default({
      unit_analysis: "unit-analysis-v4",
    }),
  /** Steps that must never auto-run without explicit --step (e.g. OpenAI). */
  require_explicit_step: z
    .array(z.string())
    .default([
      "analyze.sap_code_units",
      "analyze.control_tables",
      "interpret.code_table",
    ]),
});

/**
 * Customer-facing profile. No SAP business constants — only wiring.
 * `data_root_project_key` maps to LOCAL_DATA_ROOT/<key>/ (P01 stays P01).
 */
export const customerConfigSchema = z.object({
  schema_version: z.literal("1.0").default("1.0"),
  customer_id: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      "customer_id: Buchstaben/Ziffern/_/-",
    ),
  display_name: z.string().min(1),
  systems: z.array(customerSystemSchema).min(1),
  /** Folder under LOCAL_DATA_ROOT — usually equals customer_id. */
  data_root_project_key: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  enabled_source_types: z
    .array(
      z.enum([
        "sap_class",
        "sap_control_table",
        "document",
        "ticket",
        "other",
      ]),
    )
    .default(["sap_class", "sap_control_table"]),
  pipeline_defaults: customerPipelineDefaultsSchema.default({
    prompt_versions: { unit_analysis: "unit-analysis-v4" },
    require_explicit_step: [
      "analyze.sap_code_units",
      "analyze.control_tables",
      "interpret.code_table",
    ],
  }),
  paths: customerPathsSchema.default({
    raw_classes: "raw/classes",
    raw_control_tables_definitions: "raw/control-tables/definitions",
    raw_control_tables_contents: "raw/control-tables/contents",
    canonical_classes: "canonical/classes",
    canonical_control_tables: "canonical/control-tables",
    canonical_relations: "canonical/relations",
    analyses_classes: "analyses/classes",
    analyses_control_tables: "analyses/control-tables",
    analyses_relations: "analyses/relations",
    indexes_classes: "indexes/classes",
    logs: "logs",
    runs: "logs/runs",
  }),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type CustomerConfig = z.infer<typeof customerConfigSchema>;

export function customersDir(cwd = process.cwd()): string {
  return path.resolve(cwd, "customers");
}

export function resolveCustomerConfigPath(
  customerId: string,
  cwd = process.cwd(),
): string {
  const base = customersDir(cwd);
  const jsonPath = path.join(base, `${customerId}.json`);
  if (existsSync(jsonPath)) return jsonPath;
  const yamlPath = path.join(base, `${customerId}.yaml`);
  if (existsSync(yamlPath)) {
    throw new Error(
      `YAML-Kundenprofil noch nicht unterstützt: ${yamlPath}. Bitte ${customerId}.json verwenden.`,
    );
  }
  throw new Error(
    `Kundenprofil fehlt: ${jsonPath}. Vorlage: customers/_template.json`,
  );
}

export function loadCustomerConfig(
  customerId: string,
  cwd = process.cwd(),
): CustomerConfig {
  const filePath = resolveCustomerConfigPath(customerId, cwd);
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const parsed = customerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Ungültiges Kundenprofil ${filePath}: ${issues}`);
  }
  if (parsed.data.customer_id !== customerId) {
    throw new Error(
      `customer_id in Datei (${parsed.data.customer_id}) ≠ Customer-Argument (${customerId})`,
    );
  }
  return parsed.data;
}

export function resolveSystemId(
  config: CustomerConfig,
  systemId: string | undefined,
): string {
  if (systemId) {
    const found = config.systems.find((s) => s.system_id === systemId);
    if (!found) {
      throw new Error(
        `system_id "${systemId}" nicht in Kundenprofil ${config.customer_id}. Bekannt: ${config.systems
          .map((s) => s.system_id)
          .join(", ")}`,
      );
    }
    return found.system_id;
  }
  if (config.systems.length === 1) return config.systems[0]!.system_id;
  throw new Error(
    `--system erforderlich (mehrere Systeme: ${config.systems
      .map((s) => s.system_id)
      .join(", ")})`,
  );
}
