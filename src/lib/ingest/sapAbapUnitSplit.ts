/**
 * Deterministic ABAP code-unit split (FORM / MODULE / CLASS / METHOD / FUNCTION).
 * Never splits mid-unit; unmatched residual stays with the parent unit.
 */

export type SplitUnitType =
  | "FORM"
  | "MODULE"
  | "CLASS"
  | "METHOD"
  | "FUNCTION"
  | "PROGRAM"
  | "INCLUDE"
  | "OTHER";

export type SplitCodeUnit = {
  unit_type: SplitUnitType;
  unit_name: string;
  /** 1-based line in parent source_code */
  start_line: number;
  end_line: number;
  source_code: string;
  line_count: number;
};

type OpenUnit = {
  unit_type: SplitUnitType;
  unit_name: string;
  start_line: number;
  endToken: string;
  /** CLASS IMPLEMENTATION nests METHOD */
  nestable: boolean;
};

const START_PATTERNS: Array<{
  re: RegExp;
  unit_type: SplitUnitType;
  endToken: string;
  nestable: boolean;
}> = [
  {
    re: /^\s*FUNCTION\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\s*\.?/i,
    unit_type: "FUNCTION",
    endToken: "ENDFUNCTION",
    nestable: false,
  },
  {
    re: /^\s*FORM\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\b/i,
    unit_type: "FORM",
    endToken: "ENDFORM",
    nestable: false,
  },
  {
    re: /^\s*MODULE\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\b/i,
    unit_type: "MODULE",
    endToken: "ENDMODULE",
    nestable: false,
  },
  {
    re: /^\s*CLASS\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\s+IMPLEMENTATION\b/i,
    unit_type: "CLASS",
    endToken: "ENDCLASS",
    nestable: true,
  },
  {
    re: /^\s*CLASS\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\s+DEFINITION\b/i,
    unit_type: "CLASS",
    endToken: "ENDCLASS",
    nestable: false,
  },
  {
    re: /^\s*METHOD\s+([\/A-Za-z_][\/A-Za-z0-9_]*)\b/i,
    unit_type: "METHOD",
    endToken: "ENDMETHOD",
    nestable: false,
  },
];

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("*");
}

function matchesEnd(line: string, endToken: string): boolean {
  const re = new RegExp(`^\\s*${endToken}\\b`, "i");
  return re.test(line);
}

/**
 * Split ABAP source into coherent nested units.
 * Top-level FORM/MODULE/FUNCTION/CLASS and METHOD inside CLASS IMPLEMENTATION.
 */
export function splitAbapCodeUnits(sourceCode: string): SplitCodeUnit[] {
  const lines = sourceCode.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const units: SplitCodeUnit[] = [];
  const stack: OpenUnit[] = [];

  const pushClosed = (open: OpenUnit, endLine: number) => {
    const slice = lines.slice(open.start_line - 1, endLine);
    const code = slice.join("\n");
    units.push({
      unit_type: open.unit_type,
      unit_name: open.unit_name,
      start_line: open.start_line,
      end_line: endLine,
      source_code: code,
      line_count: slice.length,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;
    if (isCommentOrBlank(line)) continue;

    const top = stack[stack.length - 1];

    if (top && matchesEnd(line, top.endToken)) {
      // Closing current unit
      pushClosed(top, lineNumber);
      stack.pop();
      continue;
    }

    // METHOD only when inside nestable CLASS IMPLEMENTATION (or top-level)
    for (const pat of START_PATTERNS) {
      const m = line.match(pat.re);
      if (!m?.[1]) continue;
      if (pat.unit_type === "METHOD") {
        const inClassImpl = stack.some(
          (s) => s.unit_type === "CLASS" && s.nestable,
        );
        // Allow METHOD at top-level or inside CLASS IMPLEMENTATION
        if (stack.length > 0 && !inClassImpl) continue;
      } else if (stack.length > 0) {
        // FORM/MODULE/FUNCTION/CLASS never nest inside another open unit
        continue;
      }

      stack.push({
        unit_type: pat.unit_type,
        unit_name: m[1].toUpperCase(),
        start_line: lineNumber,
        endToken: pat.endToken,
        nestable: pat.nestable,
      });
      break;
    }
  }

  // Unclosed units: keep from start to EOF (still coherent — no mid-cut)
  while (stack.length > 0) {
    const open = stack.pop()!;
    pushClosed(open, lines.length);
  }

  return units;
}
