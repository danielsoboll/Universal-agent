/**
 * Baut ein lexikalisches Korpus aus vorhandenen Canonical-/Analyse-Artefakten.
 * Nur lesen — keine Pipeline, kein OpenAI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { resolveProjectZonePath } from "@/lib/localData/paths";
import type { LexicalDocument } from "@/lib/search/lexical/types";

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function pushUnique(out: LexicalDocument[], doc: LexicalDocument): void {
  if (!out.some((d) => d.id === doc.id)) out.push(doc);
}

function buildFieldSearchText(parts: {
  technical_name: string;
  field_text: string;
  data_element: string;
  data_element_text: string;
  domain: string;
  domain_text: string;
  table_name: string;
  field_name: string;
  append: string;
}): string {
  return [
    parts.technical_name,
    parts.table_name,
    parts.field_name,
    parts.field_text,
    parts.data_element,
    parts.data_element_text,
    parts.domain,
    parts.domain_text,
    parts.append,
  ]
    .filter(Boolean)
    .join(" · ");
}

function loadMasterFields(projectKey: string, out: LexicalDocument[]): void {
  const mdRoot = resolveProjectZonePath(projectKey, "canonical", "master-data");
  if (!existsSync(mdRoot)) return;
  for (const domain of ["customers", "materials", "vendors"] as const) {
    const domainDir = path.join(mdRoot, domain);
    if (!existsSync(domainDir) || !statSync(domainDir).isDirectory()) continue;
    for (const table of readdirSync(domainDir)) {
      const structurePath = path.join(domainDir, table, "structure.jsonl");
      if (!existsSync(structurePath)) continue;
      const rel = `canonical/master-data/${domain}/${table}/structure.jsonl`;
      for (const line of readFileSync(structurePath, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (asString(rec.record_type) !== "master_field_definition") continue;
        const table_name = asString(rec.table_name) || table.toUpperCase();
        const field_name = asString(rec.field_name);
        if (!field_name) continue;
        const field_text = asString(rec.description) || asString(rec.field_text);
        const data_element = asString(rec.data_element);
        const data_element_text = asString(rec.data_element_text);
        const domainName = asString(rec.domain);
        const domain_text = asString(rec.domain_text);
        const append =
          rec._is_append_include === true
            ? "append_include"
            : asString(rec.append_include) || "";
        const technical_name = `${table_name}-${field_name}`;
        const doc: LexicalDocument = {
          id: `ddic_field:${table_name}:${field_name}`,
          kind: "ddic_field",
          technical_name,
          title: technical_name,
          table_name,
          field_name,
          field_text,
          data_element: data_element || undefined,
          data_element_text: data_element_text || undefined,
          domain: domainName || undefined,
          domain_text: domain_text || undefined,
          append_include: append || Boolean(rec._is_append_include),
          source_path: rel,
          search_text: buildFieldSearchText({
            technical_name,
            field_text,
            data_element,
            data_element_text,
            domain: domainName,
            domain_text,
            table_name,
            field_name,
            append,
          }),
          metadata: {
            profile: asString(rec.profile) || null,
            is_z_field: Boolean(rec._is_z_field),
          },
        };
        pushUnique(out, doc);

        if (data_element) {
          pushUnique(out, {
            id: `data_element:${data_element}`,
            kind: "data_element",
            technical_name: data_element,
            title: data_element,
            data_element,
            data_element_text: data_element_text || undefined,
            // Kein field_text-Kopieren — sonst stehlen Datenelemente Feldphrasen
            source_path: rel,
            search_text: [data_element, data_element_text]
              .filter(Boolean)
              .join(" · "),
          });
        }
        if (domainName) {
          pushUnique(out, {
            id: `domain:${domainName}`,
            kind: "domain",
            technical_name: domainName,
            title: domainName,
            domain: domainName,
            domain_text: domain_text || undefined,
            source_path: rel,
            search_text: [domainName, domain_text].filter(Boolean).join(" · "),
          });
        }
      }

      // Tabellenprofil / Tabellen-Dokument
      pushUnique(out, {
        id: `ddic_table:${table.toUpperCase()}`,
        kind: "ddic_table",
        technical_name: table.toUpperCase(),
        title: table.toUpperCase(),
        table_name: table.toUpperCase(),
        table_text: `${domain} Stammdatentabelle ${table}`,
        source_path: rel,
        search_text: `${table.toUpperCase()} ${domain} stammdaten tabelle`,
      });
    }
  }
}

function loadControlTables(projectKey: string, out: LexicalDocument[]): void {
  const defPath = resolveProjectZonePath(
    projectKey,
    "canonical",
    "control-tables",
    "table_definitions.jsonl",
  );
  if (existsSync(defPath)) {
    for (const line of readFileSync(defPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const name =
        asString(rec.table_name) ||
        asString(rec.name) ||
        asString(rec.object_name);
      if (!name) continue;
      const text =
        asString(rec.description) ||
        asString(rec.table_text) ||
        asString(rec.business_purpose) ||
        asString(rec.title);
      pushUnique(out, {
        id: `control_table:${name}`,
        kind: "control_table",
        technical_name: name.toUpperCase(),
        title: name.toUpperCase(),
        table_name: name.toUpperCase(),
        table_text: text,
        field_text: text,
        source_path: "canonical/control-tables/table_definitions.jsonl",
        search_text: [name, text].filter(Boolean).join(" · "),
      });
    }
  }

  const entitiesPath = resolveProjectZonePath(
    projectKey,
    "canonical",
    "control-tables",
    "table_entities.jsonl",
  );
  if (existsSync(entitiesPath)) {
    for (const line of readFileSync(entitiesPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const table = asString(rec.table_name);
      const field = asString(rec.field_name) || asString(rec.name);
      if (!table || !field) continue;
      const field_text =
        asString(rec.description) ||
        asString(rec.field_text) ||
        asString(rec.short_text);
      const technical_name = `${table}-${field}`;
      pushUnique(out, {
        id: `ddic_field:ct:${table}:${field}`,
        kind: "ddic_field",
        technical_name,
        title: technical_name,
        table_name: table,
        field_name: field,
        field_text,
        data_element: asString(rec.data_element) || undefined,
        domain: asString(rec.domain) || undefined,
        source_path: "canonical/control-tables/table_entities.jsonl",
        search_text: [technical_name, field_text, asString(rec.data_element)]
          .filter(Boolean)
          .join(" · "),
      });
    }
  }
}

function loadCodeUnits(
  projectKey: string,
  zone: "classes" | "programs" | "function-modules",
  out: LexicalDocument[],
): void {
  const unitsPath = resolveProjectZonePath(
    projectKey,
    "canonical",
    zone,
    "code_units.jsonl",
  );
  if (!existsSync(unitsPath)) return;
  const rel = `canonical/${zone}/code_units.jsonl`;
  for (const line of readFileSync(unitsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const unitType = asString(rec.unit_type).toUpperCase();
    const sourceKey = asString(rec.source_key);
    const skParts = sourceKey.split("|").map((p) => p.trim());
    const skMethodIdx = skParts.findIndex((p) => p.toUpperCase() === "METHOD");
    const skFormIdx = skParts.findIndex((p) => p.toUpperCase() === "FORM");
    const name =
      asString(rec.method_name) ||
      asString(rec.form_name) ||
      asString(rec.include_name) ||
      (skMethodIdx >= 0 ? skParts[skMethodIdx + 1] ?? "" : "") ||
      (skFormIdx >= 0 ? skParts[skFormIdx + 1] ?? "" : "") ||
      asString(rec.object_name) ||
      asString(rec.name);
    const objectName = asString(rec.object_name) || asString(rec.class_name);
    if (!name && !objectName && !sourceKey) continue;

    let kind: LexicalDocument["kind"] = "program";
    if (zone === "classes") {
      kind = unitType.includes("METHOD") || name ? "method" : "class";
    } else if (zone === "function-modules") {
      kind = "function_module";
    } else if (unitType.includes("FORM")) {
      kind = "form_routine";
    } else if (unitType.includes("INCLUDE")) {
      kind = "include";
    } else {
      kind = "program";
    }

    const technical_name =
      sourceKey ||
      (objectName && name ? `${objectName}-${name}` : objectName || name);
    const summary =
      asString(rec.summary) ||
      asString(rec.technical_summary) ||
      asString(rec.description) ||
      asString(rec.business_purpose);
    const tables = [
      ...(Array.isArray(rec.tables_read) ? rec.tables_read.map(String) : []),
      ...(Array.isArray(rec.tables_written) ? rec.tables_written.map(String) : []),
    ];
    pushUnique(out, {
      id: `${kind}:${technical_name}`,
      kind,
      technical_name,
      title: technical_name,
      code_summary: summary || undefined,
      source_path: rel,
      search_text: [technical_name, objectName, name, summary, ...tables.slice(0, 12)]
        .filter(Boolean)
        .join(" · "),
      metadata: { unit_type: unitType, zone },
    });
  }
}

function loadMessageConfig(projectKey: string, out: LexicalDocument[]): void {
  const objectsPath = resolveProjectZonePath(
    projectKey,
    "canonical",
    "message-idoc-config",
    "objects.jsonl",
  );
  if (!existsSync(objectsPath)) return;
  const rel = "canonical/message-idoc-config/objects.jsonl";
  let n = 0;
  for (const line of readFileSync(objectsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name =
      asString(rec.object_name) ||
      asString(rec.name) ||
      asString(rec.kschl) ||
      asString(rec.output_type);
    if (!name) continue;
    const text =
      asString(rec.description) ||
      asString(rec.text) ||
      asString(rec.vtext) ||
      asString(rec.title);
    pushUnique(out, {
      id: `message_config:${name}:${n}`,
      kind: "message_config",
      technical_name: name.toUpperCase(),
      title: name.toUpperCase(),
      field_text: text,
      source_path: rel,
      search_text: [name, text].filter(Boolean).join(" · "),
    });
    n += 1;
    if (n >= 50_000) break; // safety bound
  }
}

function loadTableProfiles(projectKey: string, out: LexicalDocument[]): void {
  const classPath = resolveProjectZonePath(
    projectKey,
    "canonical",
    "control-tables",
    "table_classifications.jsonl",
  );
  if (!existsSync(classPath)) return;
  for (const line of readFileSync(classPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = asString(rec.table_name);
    if (!name) continue;
    const text =
      asString(rec.category) ||
      asString(rec.classification) ||
      asString(rec.description);
    pushUnique(out, {
      id: `table_profile:${name}`,
      kind: "table_profile",
      technical_name: name.toUpperCase(),
      title: name.toUpperCase(),
      table_name: name.toUpperCase(),
      table_text: text,
      source_path: "canonical/control-tables/table_classifications.jsonl",
      search_text: [name, text].filter(Boolean).join(" · "),
    });
  }
}

/**
 * Liest Canonical-Artefakte und erzeugt LexicalDocuments.
 */
export function buildLexicalCorpus(projectKey: string): LexicalDocument[] {
  const out: LexicalDocument[] = [];
  loadMasterFields(projectKey, out);
  loadControlTables(projectKey, out);
  loadTableProfiles(projectKey, out);
  loadCodeUnits(projectKey, "classes", out);
  loadCodeUnits(projectKey, "programs", out);
  loadCodeUnits(projectKey, "function-modules", out);
  loadMessageConfig(projectKey, out);
  return out;
}
