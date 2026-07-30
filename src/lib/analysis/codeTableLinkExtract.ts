import {
  buildTableDefinitionSourceKey,
  normalizeCellValue,
  serializeCanonicalPrimaryKey,
  sha256,
  stableStringify,
  type CanonicalTableDefinition,
  type CanonicalTableRow,
} from "@/lib/ingest/controlTables/model";

export type WhereCondition = {
  field: string;
  operator: string;
  value_kind: "literal" | "variable" | "unknown";
  raw_value: string;
  resolved_literal: string | null;
};

export type CodeTableAccess = {
  code_source_key: string;
  method_name: string;
  access_kind: "READ" | "WRITE";
  table_name: string;
  selected_fields: string[];
  into_target: string | null;
  where: WhereCondition[];
  evidence_code: string;
  line_start: number;
};

export type CodeTableLinkRelation = {
  record_type: "code_table_relation";
  schema_version: string;
  source_key: string;
  relation_type: string;
  from_type: string;
  from_key: string;
  to_type: string;
  to_key: string;
  confidence: number;
  metadata: Record<string, unknown>;
  evidence_from_code: string[];
  evidence_from_table: string[];
  content_hash: string;
};

export type CodeTableLinkResult = {
  accesses: CodeTableAccess[];
  relations: CodeTableLinkRelation[];
  stats: {
    code_units_scanned: number;
    code_units_with_table_access: number;
    accesses: number;
    reads: number;
    writes: number;
    resolved_rows: number;
    candidate_resolutions: number;
    unresolved_dynamic: number;
    relations: number;
  };
  examples: Array<{
    code_source_key: string;
    method_name: string;
    table_name: string;
    relation_type: string;
    evidence_from_code: string;
    evidence_from_table: string;
    resolved_key?: string;
  }>;
};

function stripComments(sourceCode: string): string {
  return sourceCode
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^\s*\*/.test(line)) return "";
      const quote = line.indexOf('"');
      if (quote >= 0) return line.slice(0, quote);
      return line;
    })
    .join("\n");
}

function isInternalName(name: string): boolean {
  const n = name.toUpperCase();
  return /^(L_|G_|LT_|GT_|LS_|GS_|IT_|IS_|WA_|<|SY)/.test(n);
}

/** Collect simple assignments var = 'lit' / var = number within method. */
export function extractLiteralAssignments(
  code: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of code.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']*)'/gi,
  )) {
    map.set(match[1]!.toUpperCase(), match[2] ?? "");
  }
  for (const match of code.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\b/gi,
  )) {
    const name = match[1]!.toUpperCase();
    if (!map.has(name)) map.set(name, match[2] ?? "");
  }
  for (const match of code.matchAll(
    /\bMOVE\s+'([^']*)'\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
  )) {
    map.set(match[2]!.toUpperCase(), match[1] ?? "");
  }
  return map;
}

function lineNumberAt(code: string, index: number): number {
  return code.slice(0, Math.max(0, index)).split("\n").length;
}

/** End index of an ABAP statement starting at `from`, honoring quoted literals. */
function abapStatementEnd(code: string, from: number): number {
  let inQuote = false;
  for (let i = from; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "'") {
      if (inQuote && code[i + 1] === "'") {
        i += 1;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === ".") return i;
  }
  return code.length;
}

function parseWhereClause(
  whereText: string,
  assignments: Map<string, string>,
): WhereCondition[] {
  const conditions: WhereCondition[] = [];
  // Cut trailing junk after statement (safety)
  const cleaned = whereText.split(/\n/).join(" ").replace(/\s+/g, " ").trim();
  if (!cleaned) return conditions;

  const parts = cleaned.split(/\bAND\b/i);
  for (const part of parts) {
    const m = part.match(
      /^\s*([\/A-Za-z_][\/A-Za-z0-9_]*)\s*(EQ|=|NE|<>|LT|<|GT|>|LE|<=|GE|>=)\s*(.+?)\s*$/i,
    );
    if (!m) continue;
    const field = m[1]!.toUpperCase();
    const operator = m[2]!.toUpperCase().replace("EQ", "=").replace("NE", "<>");
    let rhs = (m[3] ?? "").trim().replace(/[.,;]+$/, "");

    let value_kind: WhereCondition["value_kind"] = "unknown";
    let raw_value = rhs;
    let resolved_literal: string | null = null;

    const lit = rhs.match(/^'(.*)'$/);
    if (lit) {
      value_kind = "literal";
      raw_value = lit[1] ?? "";
      resolved_literal = raw_value;
    } else if (/^-?\d+(\.\d+)?$/.test(rhs)) {
      value_kind = "literal";
      raw_value = rhs;
      resolved_literal = rhs;
    } else {
      const varName = rhs.trim().toUpperCase();
      value_kind = "variable";
      raw_value = rhs;
      if (assignments.has(varName)) {
        resolved_literal = assignments.get(varName) ?? null;
      } else {
        const simple = varName.split(/[-]/).pop() ?? varName;
        if (assignments.has(simple)) {
          resolved_literal = assignments.get(simple) ?? null;
        }
      }
    }

    conditions.push({
      field,
      operator,
      value_kind,
      raw_value,
      resolved_literal,
    });
  }
  return conditions;
}

/**
 * Extract SELECT/UPDATE/MODIFY/INSERT/DELETE table accesses from one method.
 */
export function extractTableAccessesFromCode(params: {
  sourceKey: string;
  methodName: string;
  sourceCode: string;
}): CodeTableAccess[] {
  const code = stripComments(params.sourceCode);
  const assignments = extractLiteralAssignments(code);
  const accesses: CodeTableAccess[] = [];

  // Statement-oriented SELECT … FROM table …
  for (const match of code.matchAll(/\bSELECT\b/gi)) {
    const start = match.index ?? 0;
    const end = abapStatementEnd(code, start);
    const stmt = code.slice(start, end);
    const fromMatch = stmt.match(
      /\bFROM\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\b/i,
    );
    if (!fromMatch) continue;
    const table = (fromMatch[1] ?? "").toUpperCase();
    if (isInternalName(table)) continue;

    const head = stmt.slice(0, fromMatch.index ?? 0);
    const afterFrom = stmt.slice((fromMatch.index ?? 0) + fromMatch[0].length);

    const whereMatch = afterFrom.match(/\bWHERE\b([\s\S]*)/i);
    const intoMatch =
      afterFrom.match(
        /\bINTO\s+(?:CORRESPONDING\s+FIELDS\s+OF\s+(?:TABLE\s+)?)?(\(?\s*[\/A-Za-z_][\/A-Za-z0-9_\-\s,]*\)?)/i,
      ) ??
      head.match(
        /\bINTO\s+(?:CORRESPONDING\s+FIELDS\s+OF\s+(?:TABLE\s+)?)?([\/A-Za-z_][\/A-Za-z0-9_-]*)/i,
      );

    let into_target: string | null = null;
    if (intoMatch?.[1]) {
      const rawInto = intoMatch[1].trim();
      // take first token / first component target
      const first = rawInto
        .replace(/^\(/, "")
        .split(",")[0]
        ?.trim()
        .split(/\s+/)[0];
      into_target = first ? first.toUpperCase() : null;
    }

    const fieldPart = head
      .replace(/^\s*SELECT\b/i, "")
      .replace(/\bSINGLE\b/gi, "")
      .replace(/\bINTO\b[\s\S]*/i, "")
      .trim();
    const selected_fields =
      !fieldPart || fieldPart === "*"
        ? ["*"]
        : fieldPart
            .split(/[\s,]+/)
            .map((f) => f.toUpperCase())
            .filter((f) => f && !["SINGLE", "DISTINCT"].includes(f));

    accesses.push({
      code_source_key: params.sourceKey,
      method_name: params.methodName,
      access_kind: "READ",
      table_name: table,
      selected_fields,
      into_target,
      where: parseWhereClause(whereMatch?.[1] ?? "", assignments),
      evidence_code: stmt.replace(/\s+/g, " ").trim().slice(0, 240),
      line_start: lineNumberAt(code, start),
    });
  }

  // UPDATE table SET … WHERE …
  for (const match of code.matchAll(/\bUPDATE\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\s+SET\b/gi)) {
    const start = match.index ?? 0;
    const end = abapStatementEnd(code, start);
    const stmt = code.slice(start, end);
    const table = (match[1] ?? "").toUpperCase();
    if (isInternalName(table)) continue;
    const whereMatch = stmt.match(/\bWHERE\b([\s\S]*)/i);
    accesses.push({
      code_source_key: params.sourceKey,
      method_name: params.methodName,
      access_kind: "WRITE",
      table_name: table,
      selected_fields: [],
      into_target: null,
      where: parseWhereClause(whereMatch?.[1] ?? "", assignments),
      evidence_code: stmt.replace(/\s+/g, " ").trim().slice(0, 240),
      line_start: lineNumberAt(code, start),
    });
  }

  // INSERT / MODIFY / DELETE table
  for (const match of code.matchAll(
    /\b(INSERT|MODIFY|DELETE)\b\s+(?:FROM\s+)?(?:TABLE\s+)?([\/A-Za-z_][\/A-Za-z0-9_]*)\b/gi,
  )) {
    const start = match.index ?? 0;
    const end = abapStatementEnd(code, start);
    const stmt = code.slice(start, end);
    const verb = (match[1] ?? "").toUpperCase();
    const table = (match[2] ?? "").toUpperCase();
    if (verb === "DELETE" && table === "ADJACENT") continue;
    if (isInternalName(table)) continue;
    if (["SET", "INTO", "CORRESPONDING"].includes(table)) continue;
    accesses.push({
      code_source_key: params.sourceKey,
      method_name: params.methodName,
      access_kind: "WRITE",
      table_name: table,
      selected_fields: [],
      into_target: null,
      where: [],
      evidence_code: stmt.replace(/\s+/g, " ").trim().slice(0, 240),
      line_start: lineNumberAt(code, start),
    });
  }

  return accesses;
}

function valuesEquivalent(a: string, b: string): boolean {
  const na = normalizeCellValue(a);
  const nb = normalizeCellValue(b);
  if (na === nb) return true;
  if (na.toUpperCase() === nb.toUpperCase()) return true;
  // numeric padding: '010' vs '10' vs '1'
  const da = na.replace(/^0+/, "") || "0";
  const db = nb.replace(/^0+/, "") || "0";
  if (/^\d+$/.test(na) && /^\d+$/.test(nb) && da === db) return true;
  return false;
}

export function matchRowsForAccess(params: {
  access: CodeTableAccess;
  definition: CanonicalTableDefinition | undefined;
  rows: CanonicalTableRow[];
  client: string;
}): {
  resolved: CanonicalTableRow[];
  candidates: CanonicalTableRow[];
  matchedConditions: Array<{ field: string; value: string }>;
  dynamic: boolean;
} {
  const eqConditions = params.access.where.filter(
    (w) => w.operator === "=" || w.operator === "EQ",
  );
  const resolvedConds = eqConditions
    .map((w) => ({
      field: w.field,
      value: w.resolved_literal,
      kind: w.value_kind,
    }))
    .filter((c) => c.value != null) as Array<{
    field: string;
    value: string;
    kind: string;
  }>;

  const hasUnresolvedVar = eqConditions.some(
    (w) => w.value_kind === "variable" && w.resolved_literal == null,
  );

  if (resolvedConds.length === 0) {
    return {
      resolved: [],
      candidates: [],
      matchedConditions: [],
      dynamic: hasUnresolvedVar || eqConditions.length === 0,
    };
  }

  const keyFields = (params.definition?.key_fields ?? []).map((f) =>
    f.toUpperCase(),
  );
  const nonClientKeys = keyFields.filter((f) => f !== "MANDT");

  const matched = params.rows.filter((row) => {
    if (row.table_name !== params.access.table_name) return false;
    if (row.client && params.client && row.client !== params.client) {
      // still allow if MANDT matched in conditions
    }
    return resolvedConds.every((c) => {
      const fromPk = row.primary_key[c.field] ?? row.primary_key[
        Object.keys(row.primary_key).find((k) => k.toUpperCase() === c.field) ?? ""
      ];
      const fromVal =
        row.values[c.field] ??
        row.values[
          Object.keys(row.values).find((k) => k.toUpperCase() === c.field) ?? ""
        ];
      const cell = fromPk ?? fromVal;
      if (cell == null) return false;
      return valuesEquivalent(String(cell), c.value);
    });
  });

  const matchedConditions = resolvedConds.map((c) => ({
    field: c.field,
    value: c.value,
  }));

  // Full key coverage (ignoring MANDT if not in WHERE but client known)?
  const whereFields = new Set(resolvedConds.map((c) => c.field));
  const coversAllKeys =
    nonClientKeys.length > 0 &&
    nonClientKeys.every((k) => whereFields.has(k)) &&
    matched.length === 1;

  const coversAllKeysIncludingClient =
    keyFields.length > 0 &&
    keyFields.every(
      (k) =>
        whereFields.has(k) ||
        (k === "MANDT" && matched.length === 1),
    ) &&
    matched.length === 1;

  if (coversAllKeys || coversAllKeysIncludingClient) {
    return {
      resolved: matched,
      candidates: [],
      matchedConditions,
      dynamic: false,
    };
  }

  if (matched.length === 1 && resolvedConds.length > 0) {
    // Unique match on partial conditions → still resolve with lower confidence later
    return {
      resolved: matched,
      candidates: [],
      matchedConditions,
      dynamic: false,
    };
  }

  return {
    resolved: [],
    candidates: matched,
    matchedConditions,
    dynamic: hasUnresolvedVar,
  };
}

function rel(params: {
  relation_type: string;
  from_key: string;
  to_type: string;
  to_key: string;
  confidence: number;
  metadata?: Record<string, unknown>;
  evidence_from_code?: string[];
  evidence_from_table?: string[];
}): CodeTableLinkRelation {
  const body = {
    relation_type: params.relation_type,
    from_type: "CODE_UNIT",
    from_key: params.from_key,
    to_type: params.to_type,
    to_key: params.to_key,
    confidence: params.confidence,
    metadata: params.metadata ?? {},
  };
  return {
    record_type: "code_table_relation",
    schema_version: "1.0",
    source_key: sha256(stableStringify(body)).slice(0, 40),
    ...body,
    evidence_from_code: params.evidence_from_code ?? [],
    evidence_from_table: params.evidence_from_table ?? [],
    content_hash: sha256(stableStringify(body)),
  };
}

/**
 * Link code units to control-table definitions/rows (deterministic).
 */
export function linkCodeUnitsToControlTables(params: {
  codeUnits: Array<{
    source_key: string;
    unit_name?: string;
    source_code: string;
  }>;
  definitions: CanonicalTableDefinition[];
  rows: CanonicalTableRow[];
}): CodeTableLinkResult {
  const defByTable = new Map<string, CanonicalTableDefinition>();
  for (const d of params.definitions) {
    defByTable.set(d.table_name.toUpperCase(), d);
  }
  const rowsByTable = new Map<string, CanonicalTableRow[]>();
  for (const r of params.rows) {
    const k = r.table_name.toUpperCase();
    const list = rowsByTable.get(k) ?? [];
    list.push(r);
    rowsByTable.set(k, list);
  }

  const knownTables = new Set(defByTable.keys());
  const accesses: CodeTableAccess[] = [];
  const relations: CodeTableLinkRelation[] = [];
  const examples: CodeTableLinkResult["examples"] = [];

  let resolved_rows = 0;
  let candidate_resolutions = 0;
  let unresolved_dynamic = 0;
  const unitsWithAccess = new Set<string>();

  for (const unit of params.codeUnits) {
    const extracted = extractTableAccessesFromCode({
      sourceKey: unit.source_key,
      methodName: unit.unit_name ?? "",
      sourceCode: unit.source_code,
    });

    // Prefer known control/customizing tables; still record SAP std tables if in definitions
    const relevant = extracted.filter((a) => knownTables.has(a.table_name));
    if (relevant.length === 0) continue;

    unitsWithAccess.add(unit.source_key);
    for (const access of relevant) {
      accesses.push(access);
      const definition = defByTable.get(access.table_name);
      const tableKey =
        definition?.source_key ??
        buildTableDefinitionSourceKey("?", "?", access.table_name);

      relations.push(
        rel({
          relation_type:
            access.access_kind === "READ" ? "READS_TABLE" : "WRITES_TABLE",
          from_key: access.code_source_key,
          to_type: "TABLE",
          to_key: tableKey,
          confidence: 0.95,
          metadata: {
            table_name: access.table_name,
            line_start: access.line_start,
          },
          evidence_from_code: [access.evidence_code],
        }),
      );

      for (const w of access.where) {
        relations.push(
          rel({
            relation_type: "FILTERS_BY_FIELD",
            from_key: access.code_source_key,
            to_type: "FIELD",
            to_key: `${access.table_name}.${w.field}`,
            confidence: 0.9,
            metadata: { operator: w.operator, table_name: access.table_name },
            evidence_from_code: [access.evidence_code],
          }),
        );
        if (w.value_kind === "literal" || w.resolved_literal != null) {
          relations.push(
            rel({
              relation_type: "FILTERS_BY_LITERAL",
              from_key: access.code_source_key,
              to_type: "LITERAL",
              to_key: `${w.field}=${w.resolved_literal ?? w.raw_value}`,
              confidence: w.resolved_literal != null ? 0.92 : 0.85,
              metadata: {
                field: w.field,
                literal: w.resolved_literal ?? w.raw_value,
                via_variable:
                  w.value_kind === "variable" ? w.raw_value : null,
              },
              evidence_from_code: [access.evidence_code],
            }),
          );
        } else if (w.value_kind === "variable") {
          relations.push(
            rel({
              relation_type: "FILTERS_BY_VARIABLE",
              from_key: access.code_source_key,
              to_type: "VARIABLE",
              to_key: w.raw_value.toUpperCase(),
              confidence: 0.7,
              metadata: { field: w.field },
              evidence_from_code: [access.evidence_code],
            }),
          );
        }
      }

      for (const field of access.selected_fields) {
        if (field === "*") continue;
        relations.push(
          rel({
            relation_type: "READS_TABLE_FIELD",
            from_key: access.code_source_key,
            to_type: "FIELD",
            to_key: `${access.table_name}.${field}`,
            confidence: 0.9,
            evidence_from_code: [access.evidence_code],
          }),
        );
      }

      const client = definition?.client ?? params.rows[0]?.client ?? "001";
      const match = matchRowsForAccess({
        access,
        definition,
        rows: rowsByTable.get(access.table_name) ?? [],
        client,
      });

      if (match.dynamic && match.resolved.length === 0 && match.candidates.length === 0) {
        unresolved_dynamic += 1;
      }

      if (match.resolved.length === 1) {
        resolved_rows += 1;
        const row = match.resolved[0]!;
        const pk = serializeCanonicalPrimaryKey(
          definition?.key_fields ?? Object.keys(row.primary_key),
          row.primary_key,
        );
        relations.push(
          rel({
            relation_type: "RESOLVES_TABLE_ROW",
            from_key: access.code_source_key,
            to_type: "TABLE_ROW",
            to_key: row.source_key,
            confidence: 0.9,
            metadata: {
              table_name: access.table_name,
              resolved_key: pk,
              matched_conditions: match.matchedConditions,
              resolved_values: row.values,
            },
            evidence_from_code: [access.evidence_code],
            evidence_from_table: [
              `${row.table_name} ${pk}`,
              JSON.stringify(row.values).slice(0, 200),
            ],
          }),
        );

        // usage after read: IF into-field / variable comparisons
        if (access.into_target) {
          relations.push(
            rel({
              relation_type: "USES_RESOLVED_VALUE",
              from_key: access.code_source_key,
              to_type: "TABLE_ROW",
              to_key: row.source_key,
              confidence: 0.75,
              metadata: { into_target: access.into_target },
              evidence_from_code: [access.evidence_code],
              evidence_from_table: [JSON.stringify(row.values).slice(0, 120)],
            }),
          );
        }

        if (examples.length < 5) {
          examples.push({
            code_source_key: access.code_source_key,
            method_name: access.method_name,
            table_name: access.table_name,
            relation_type: "RESOLVES_TABLE_ROW",
            evidence_from_code: access.evidence_code,
            evidence_from_table: `${row.table_name}|${pk} → ${JSON.stringify(row.values).slice(0, 120)}`,
            resolved_key: pk,
          });
        }
      } else if (match.candidates.length > 0) {
        candidate_resolutions += 1;
        relations.push(
          rel({
            relation_type: "RESOLVES_TABLE_ROW_CANDIDATE",
            from_key: access.code_source_key,
            to_type: "TABLE",
            to_key: tableKey,
            confidence: Math.max(0.2, Math.min(0.7, 1 / match.candidates.length)),
            metadata: {
              table_name: access.table_name,
              candidate_count: match.candidates.length,
              matched_conditions: match.matchedConditions,
              candidate_keys: match.candidates.slice(0, 20).map((r) => r.source_key),
            },
            evidence_from_code: [access.evidence_code],
            evidence_from_table: match.candidates
              .slice(0, 3)
              .map((r) => r.source_key),
          }),
        );
      }

      // Post-read control flow: IF <into> ... / IF field EQ
      const code = stripComments(unit.source_code);
      if (access.into_target) {
        const into = access.into_target.replace(/[-].*$/, "");
        const branchRe = new RegExp(
          `\\bIF\\b[^\\n]{0,120}${into}[^\\n]{0,80}`,
          "i",
        );
        const branch = code.match(branchRe);
        if (branch) {
          relations.push(
            rel({
              relation_type: "CONTROLS_BRANCH_WITH_VALUE",
              from_key: access.code_source_key,
              to_type: "TABLE",
              to_key: tableKey,
              confidence: 0.7,
              metadata: { into_target: access.into_target },
              evidence_from_code: [branch[0]!.replace(/\s+/g, " ").slice(0, 200)],
            }),
          );
        }
      }
    }
  }

  // Deduplicate relations by source_key
  const byKey = new Map<string, CodeTableLinkRelation>();
  for (const r of relations) {
    if (!byKey.has(r.source_key)) byKey.set(r.source_key, r);
  }
  const uniqueRelations = [...byKey.values()].sort((a, b) =>
    a.source_key.localeCompare(b.source_key),
  );

  return {
    accesses,
    relations: uniqueRelations,
    stats: {
      code_units_scanned: params.codeUnits.length,
      code_units_with_table_access: unitsWithAccess.size,
      accesses: accesses.length,
      reads: accesses.filter((a) => a.access_kind === "READ").length,
      writes: accesses.filter((a) => a.access_kind === "WRITE").length,
      resolved_rows,
      candidate_resolutions,
      unresolved_dynamic,
      relations: uniqueRelations.length,
    },
    examples,
  };
}
