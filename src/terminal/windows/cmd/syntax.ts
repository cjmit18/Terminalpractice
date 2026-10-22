// CMD parse errors: the operators | & && || and > with nothing on one side.

/**
 * The error CMD prints before running anything when the line does not parse, or null.
 * "| was unexpected at this time." for an operator with no command before it, and
 * "The syntax of the command is incorrect." for a pipe or redirection with nothing after it.
 */
export function cmdSyntaxError(line: string): string | null {
  let inQuote = false;
  /** The operator that ended the previous command, while no word has followed it yet. */
  let pending: string | null = 'start';
  let redirectOpen = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '^' && !inQuote) { i++; pending = null; redirectOpen = false; continue; }
    if (c === '"') { inQuote = !inQuote; pending = null; redirectOpen = false; continue; }
    if (inQuote || /\s/.test(c)) continue;
    if (c === '|' || c === '&') {
      // 2>&1 is a redirection, not the & operator
      if (c === '&' && line[i - 1] === '>') { redirectOpen = false; continue; }
      if (redirectOpen) return 'The syntax of the command is incorrect.';
      const op = line[i + 1] === c ? c + c : c;
      if (pending !== null) return `${op} was unexpected at this time.`;
      pending = op;
      i += op.length - 1;
      continue;
    }
    if (c === '>' || c === '<') {
      if (line[i + 1] === '>') i++;
      redirectOpen = true;
      continue;
    }
    pending = null;
    redirectOpen = false;
  }
  if (redirectOpen) return 'The syntax of the command is incorrect.';
  // A trailing & is allowed (it runs nothing more); a trailing |, && or || is not
  if (pending !== null && pending !== 'start' && pending !== '&') return 'The syntax of the command is incorrect.';
  return null;
}
