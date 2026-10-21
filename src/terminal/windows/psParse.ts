// The parts of the PowerShell parser that work on a whole line: syntax errors that stop the line
// from running at all, comments, and splitting into statements on ';'.

/** The block Windows PowerShell 5.1 prints for a parse error, with the ~ under the offending text. */
export function psParseError(line: string, index: number, length: number, message: string, errorId: string): string {
  return [
    `At line:1 char:${index + 1}`,
    `+ ${line}`,
    `+ ${' '.repeat(index)}${'~'.repeat(Math.max(1, length))}`,
    message,
    '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException',
    `    + FullyQualifiedErrorId : ${errorId}`,
  ].join('\n');
}

interface Scan {
  /** Index of each statement-separating ';' outside quotes, groups and comments. */
  separators: number[];
  /** Where a # comment starts (the rest of the line is ignored), or the line length. */
  end: number;
  error?: string;
}

/**
 * Walks a PowerShell line once, the way the parser does: quotes ('' and "" with ` escapes),
 * (...), $(...), @(...) and {...} groups, # comments, pipes and statement separators.
 */
function scan(line: string): Scan {
  const separators: number[] = [];
  const stack: { ch: '(' | '{'; at: number; sub: boolean }[] = [];
  /** True while nothing but spaces has been seen since the last | (or the start of a statement). */
  let pipeOpen: number | null = null;
  let statementEmpty = true;
  const fail = (index: number, length: number, message: string, id: string): Scan => ({ separators, end: line.length, error: psParseError(line, index, length, message, id) });

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (/\s/.test(c)) continue;
    if (c === '`') { i++; statementEmpty = false; pipeOpen = null; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < line.length; j++) {
        if (c === '"' && line[j] === '`') { j++; continue; }
        if (line[j] === c) {
          // A doubled quote is a literal quote inside the string
          if (line[j + 1] === c) { j++; continue; }
          break;
        }
      }
      if (j >= line.length) {
        return fail(i, line.length - i, `The string is missing the terminator: ${c}.`, 'TerminatorExpectedAtEndOfString');
      }
      i = j;
      statementEmpty = false;
      pipeOpen = null;
      continue;
    }
    // # starts a comment at the beginning of a word
    if (c === '#' && (i === 0 || /[\s;|({]/.test(line[i - 1]))) {
      if (pipeOpen !== null) return fail(line.length, 1, 'An empty pipe element is not allowed.', 'EmptyPipeElement');
      return { separators, end: i };
    }
    if (c === '(' || c === '{') {
      stack.push({ ch: c, at: i, sub: c === '(' && (line[i - 1] === '$' || line[i - 1] === '@') });
      statementEmpty = false;
      pipeOpen = null;
      continue;
    }
    if (c === ')' || c === '}') {
      const top = stack[stack.length - 1];
      if (!top || (top.ch === '(') !== (c === ')')) {
        return fail(i, 1, `Unexpected token '${c}' in expression or statement.`, 'UnexpectedToken');
      }
      if (pipeOpen !== null) return fail(i, 1, 'An empty pipe element is not allowed.', 'EmptyPipeElement');
      stack.pop();
      continue;
    }
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) {
      return fail(i, 2, `The token '${c}${c}' is not a valid statement separator in this version.`, 'InvalidEndOfLine');
    }
    if (c === '|') {
      if (statementEmpty || pipeOpen !== null) return fail(i, 1, 'An empty pipe element is not allowed.', 'EmptyPipeElement');
      pipeOpen = i;
      continue;
    }
    if (c === ';') {
      if (pipeOpen !== null) return fail(i, 1, 'An empty pipe element is not allowed.', 'EmptyPipeElement');
      if (!stack.length) separators.push(i);
      statementEmpty = true;
      continue;
    }
    statementEmpty = false;
    pipeOpen = null;
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    if (top.ch === '{') return fail(top.at, 1, "Missing closing '}' in statement block or type definition.", 'MissingEndCurlyBrace');
    return top.sub
      ? fail(line.length, 1, "Missing closing ')' in subexpression.", 'MissingEndParenthesisInSubexpression')
      : fail(line.length, 1, "Missing closing ')' in expression.", 'MissingEndParenthesisInExpression');
  }
  // "Get-Process |" with nothing after the pipe
  if (pipeOpen !== null) return fail(line.length, 1, 'An empty pipe element is not allowed.', 'EmptyPipeElement');
  return { separators, end: line.length };
}

/** The parse error PowerShell would print for this line, or null when it parses. */
export function psSyntaxError(line: string): string | null {
  return scan(line).error ?? null;
}

/**
 * The line's statements: split on ';' outside quotes and groups, with a trailing # comment
 * removed. Assumes the line parses (see psSyntaxError).
 */
export function psSplitStatements(line: string): string[] {
  const { separators, end } = scan(line);
  const out: string[] = [];
  let start = 0;
  for (const s of [...separators, end]) {
    out.push(line.slice(start, s).trim());
    start = s + 1;
  }
  return out.filter(Boolean);
}
