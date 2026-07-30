import type {
  DeterministicExtraction,
  MethodCallRef,
} from "@/lib/analysis/unitAnalysisSchema";

const ABAP_KEYWORDS = new Set(
  [
    "IF",
    "ELSE",
    "ENDIF",
    "CASE",
    "WHEN",
    "ENDCASE",
    "LOOP",
    "ENDLOOP",
    "DO",
    "ENDDO",
    "WHILE",
    "ENDWHILE",
    "TRY",
    "ENDTRY",
    "CATCH",
    "CLEANUP",
    "FORM",
    "ENDFORM",
    "FUNCTION",
    "ENDFUNCTION",
    "METHOD",
    "ENDMETHOD",
    "CLASS",
    "ENDCLASS",
    "DATA",
    "TYPES",
    "CONSTANTS",
    "FIELD-SYMBOLS",
    "SELECT",
    "SINGLE",
    "ENDSELECT",
    "INSERT",
    "UPDATE",
    "MODIFY",
    "DELETE",
    "ADJACENT",
    "DUPLICATES",
    "COMPARING",
    "COMMIT",
    "ROLLBACK",
    "CALL",
    "CREATE",
    "OBJECT",
    "NEW",
    "TYPE",
    "REF",
    "TO",
    "VALUE",
    "IS",
    "NOT",
    "INITIAL",
    "ASSIGNED",
    "BOUND",
    "AND",
    "OR",
    "EQ",
    "NE",
    "LT",
    "GT",
    "LE",
    "GE",
    "INTO",
    "FROM",
    "WHERE",
    "INNER",
    "LEFT",
    "OUTER",
    "JOIN",
    "AS",
    "ON",
    "FOR",
    "ALL",
    "ENTRIES",
    "IN",
    "TABLE",
    "CORRESPONDING",
    "APPENDING",
    "SORT",
    "READ",
    "CHECK",
    "EXIT",
    "CONTINUE",
    "RETURN",
    "RAISE",
    "CLEAR",
    "REFRESH",
    "FREE",
    "MOVE",
    "WRITE",
    "MESSAGE",
    "EXPORTING",
    "IMPORTING",
    "CHANGING",
    "RECEIVING",
    "EXCEPTIONS",
    "DEFINE",
    "END-OF-DEFINITION",
  ].map((k) => k.toUpperCase()),
);

function stripComments(sourceCode: string): string {
  return sourceCode
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^\s*\*/.test(line)) return "";
      // Keep string literals roughly; strip " comments only outside simple cases
      const quote = line.indexOf('"');
      if (quote >= 0) return line.slice(0, quote);
      return line;
    })
    .join("\n");
}

export function normalizeToken(token: string): string {
  return token.replace(/[,.]$/, "").trim().toUpperCase();
}

/** Normalize ME->M, L_O_X->M, ZCL_X=>M, ZCL_X~M, CALL METHOD … to method name only. */
export function normalizeMethodName(raw: string): string {
  const cleaned = raw.trim();
  const staticCall = cleaned.match(
    /^([\/A-Za-z_][\/A-Za-z0-9_]*)\s*(?:=>|~)\s*([\/A-Za-z_][\/A-Za-z0-9_]*)$/i,
  );
  if (staticCall?.[2]) return normalizeToken(staticCall[2]);

  const instanceCall = cleaned.match(
    /^(?:([\/A-Za-z_][\/A-Za-z0-9_]*)\s*)?->\s*([\/A-Za-z_][\/A-Za-z0-9_]*)$/i,
  );
  if (instanceCall?.[2]) return normalizeToken(instanceCall[2]);

  const callMethod = cleaned.match(
    /^CALL\s+METHOD\s+(?:([\/A-Za-z_][\/A-Za-z0-9_]*)->)?([\/A-Za-z_][\/A-Za-z0-9_]*)$/i,
  );
  if (callMethod?.[2]) return normalizeToken(callMethod[2]);

  return normalizeToken(cleaned);
}

/** True if token after -> or => looks like a method invocation, not an attribute. */
export function looksLikeMethodInvocation(afterName: string): boolean {
  const tail = afterName.trimStart();
  if (tail.startsWith("(")) return true;
  if (
    /^(EXPORTING|IMPORTING|CHANGING|RECEIVING|EXCEPTIONS|PARAMETER-TABLE)\b/i.test(
      tail,
    )
  ) {
    return true;
  }
  return false;
}

function isLikelyDbTable(name: string): boolean {
  const n = normalizeToken(name);
  if (!n || n.length < 2) return false;
  if (ABAP_KEYWORDS.has(n)) return false;
  if (/^(L_|G_|LT_|GT_|LS_|GS_|IT_|IS_|WA_|<)/.test(n)) return false;
  if (n.includes("(") || n.includes(")")) return false;
  return true;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((v) => normalizeToken(v)).filter(Boolean))].sort();
}

function collectDefinedMacros(code: string): Set<string> {
  const macros = new Set<string>();
  for (const match of code.matchAll(/\bDEFINE\s+([\/A-Za-z_][\/A-Za-z0-9_]*)/gi)) {
    macros.add(normalizeToken(match[1] ?? ""));
  }
  return macros;
}

/**
 * Deterministic extraction of DB tables and calls from ABAP source.
 * Heuristic regex — not a full ABAP parser.
 */
export function extractAbapArtifacts(sourceCode: string): DeterministicExtraction {
  const code = stripComments(sourceCode);
  const macros = collectDefinedMacros(code);
  const tablesRead = new Set<string>();
  const tablesWritten = new Set<string>();
  const functions = new Set<string>();
  const methodRefs: MethodCallRef[] = [];
  const seenMethodRaw = new Set<string>();

  const addMethod = (raw: string, receiver: string | null, method: string) => {
    const normalized = normalizeMethodName(method);
    if (!normalized || ABAP_KEYWORDS.has(normalized)) return;
    if (macros.has(normalized)) return; // ABAP macros are not methods
    if (normalized === "SINGLE") return; // SELECT SINGLE false positive
    const rawNorm = raw.trim();
    const key = `${receiver ?? ""}=>${normalized}|${rawNorm}`;
    if (seenMethodRaw.has(key)) return;
    seenMethodRaw.add(key);
    methodRefs.push({
      raw: rawNorm,
      receiver: receiver ? normalizeToken(receiver) : null,
      method: normalized,
      normalized_method_name: normalized,
    });
  };

  // SELECT ... FROM table / JOIN table
  for (const match of code.matchAll(
    /\b(?:FROM|JOIN)\s+([\/A-Za-z_][\/A-Za-z0-9_]*)/gi,
  )) {
    const name = match[1] ?? "";
    if (isLikelyDbTable(name)) tablesRead.add(normalizeToken(name));
  }

  // UPDATE table SET
  for (const match of code.matchAll(
    /\bUPDATE\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\s+SET\b/gi,
  )) {
    const name = match[1] ?? "";
    if (isLikelyDbTable(name)) tablesWritten.add(normalizeToken(name));
  }

  // INSERT / UPDATE / MODIFY / DELETE — but never DELETE ADJACENT DUPLICATES
  for (const match of code.matchAll(
    /\b(INSERT|UPDATE|MODIFY|DELETE)\b([\s\S]{0,80})/gi,
  )) {
    const verb = normalizeToken(match[1] ?? "");
    const tail = match[2] ?? "";
    if (verb === "DELETE" && /^\s+ADJACENT\s+DUPLICATES\b/i.test(tail)) {
      continue;
    }
    const tableMatch = tail.match(
      /^\s+(?:FROM\s+)?(?:TABLE\s+)?([\/A-Za-z_][\/A-Za-z0-9_]*)/i,
    );
    const name = tableMatch?.[1] ?? "";
    const upper = normalizeToken(name);
    if (!upper || upper === "SET" || upper === "ADJACENT") continue;
    if (isLikelyDbTable(name)) tablesWritten.add(upper);
  }

  // CALL FUNCTION 'NAME' — never SELECT SINGLE
  for (const match of code.matchAll(/\bCALL\s+FUNCTION\s+'([^']+)'/gi)) {
    const name = normalizeToken(match[1] ?? "");
    if (!name || name === "SINGLE" || name.startsWith("SELECT")) continue;
    functions.add(name);
  }

  // static calls class=>method( … ) — not class=>attribute
  for (const match of code.matchAll(
    /\b([\/A-Za-z_][\/A-Za-z0-9_]*)\s*=>\s*([\/A-Za-z_][\/A-Za-z0-9_]*)/gi,
  )) {
    const recv = match[1] ?? "";
    const meth = match[2] ?? "";
    const after = code.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 40);
    if (!looksLikeMethodInvocation(after)) continue;
    addMethod(`${recv}=>${meth}`, recv, meth);
  }

  // CALL METHOD obj->meth / CALL METHOD meth
  for (const match of code.matchAll(
    /\bCALL\s+METHOD\s+(?:([\/A-Za-z_][\/A-Za-z0-9_]*)->)?([\/A-Za-z_][\/A-Za-z0-9_]*)/gi,
  )) {
    const recv = match[1] ?? null;
    const meth = match[2] ?? "";
    const raw = recv ? `CALL METHOD ${recv}->${meth}` : `CALL METHOD ${meth}`;
    addMethod(raw, recv, meth);
  }

  // me->method( … ) / obj->method — not me->attribute =
  // Also chained calls: …)->method(
  for (const match of code.matchAll(
    /(?:\b([\/A-Za-z_][\/A-Za-z0-9_]*)|\))\s*->\s*([\/A-Za-z_][\/A-Za-z0-9_]*)/gi,
  )) {
    const recv = match[1] ?? null; // null when chained from )
    const meth = match[2] ?? "";
    if (recv && normalizeToken(recv) === "CREATE") continue;
    const after = code.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 40);
    if (!looksLikeMethodInvocation(after)) continue;
    const raw = recv ? `${recv}->${meth}` : `)->${meth}`;
    addMethod(raw, recv, meth);
  }

  // Backtick macro invocations are not methods: `macro` ...
  // (already excluded unless they also use ->)

  const calledMethods = uniqueSorted(
    methodRefs.map((m) => m.normalized_method_name),
  );

  return {
    tables_read: uniqueSorted(tablesRead),
    tables_written: uniqueSorted(tablesWritten),
    called_functions: uniqueSorted(functions),
    called_methods: calledMethods,
    called_method_refs: methodRefs.sort((a, b) =>
      a.normalized_method_name.localeCompare(b.normalized_method_name),
    ),
    macro_calls: [],
  };
}
