import { readFileSync } from "fs";
import path from "path";
import {
  loadCustomerConfig,
  resolveSystemId,
  type CustomerConfig,
} from "@/lib/core/customerConfig";

export function loadEnvLocal() {
  try {
    const text = readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ")
        ? line.slice("export ".length).trim()
        : line;
      const eq = normalized.indexOf("=");
      if (eq <= 0) continue;
      const key = normalized.slice(0, eq).trim();
      let value = normalized.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key] || process.env[key]?.trim() === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // optional
  }
}

export function parseCustomerCliArgs(argv: string[]): {
  customer?: string;
  system?: string;
  query?: string;
  limit?: number;
  rest: string[];
} {
  const out: {
    customer?: string;
    system?: string;
    query?: string;
    limit?: number;
    rest: string[];
  } = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--customer") out.customer = argv[++i];
    else if (a === "--system") out.system = argv[++i];
    else if (a === "--query") out.query = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else out.rest.push(a);
  }
  return out;
}

export function resolveCustomerContext(args: {
  customer?: string;
  system?: string;
}): { config: CustomerConfig; systemId: string; projectKey: string } {
  if (!args.customer?.trim()) {
    throw new Error("--customer ist erforderlich");
  }
  const config = loadCustomerConfig(args.customer.trim());
  const systemId = resolveSystemId(config, args.system);
  process.env.PIPELINE_CUSTOMER_ID = config.customer_id;
  process.env.PIPELINE_SYSTEM_ID = systemId;
  process.env.PIPELINE_PROJECT_KEY = config.data_root_project_key;
  return {
    config,
    systemId,
    projectKey: config.data_root_project_key,
  };
}
