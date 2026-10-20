/**
 * Command line tokenization, quote-aware chaining, pipelines, and redirects
 */

export type StderrRedirect = { type: '>' | '>>'; target: string } | { type: 'merge' };

export interface ParsedCommand {
  raw: string;
  name: string;
  args: string[];
  redirect?: {
    type: '>' | '>>';
    target: string;
  };
  stderrRedirect?: StderrRedirect;
}

export interface ChainedStage {
  commandLine: string;
  nextOp?: '&&' | '||' | ';';
}

/**
 * Tokenizes a single command string into an array of arguments handling quotes and escapes
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (/\s/.test(char) && !inDoubleQuote && !inSingleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Extracts stderr redirect (2>, 2>>, 2>&1) outside quotes
 */
export function extractStderrRedirect(cmd: string): { body: string; stderr?: StderrRedirect } {
  let inD = false;
  let inS = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && !inS) {
      i++;
      continue;
    }
    if (ch === '"' && !inS) {
      inD = !inD;
      continue;
    }
    if (ch === "'" && !inD) {
      inS = !inS;
      continue;
    }
    if (inD || inS) continue;

    if (ch === '2' && cmd[i + 1] === '>' && (i === 0 || /\s/.test(cmd[i - 1]))) {
      const m = cmd.slice(i).match(/^2>(>?)\s*(&1|[^\s|&;]+)/);
      if (!m) continue;
      const body = (cmd.slice(0, i) + cmd.slice(i + m[0].length)).trim();
      const stderr: StderrRedirect = m[2] === '&1'
        ? { type: 'merge' }
        : { type: m[1] ? '>>' : '>', target: m[2] };
      return { body, stderr };
    }
  }
  return { body: cmd };
}

/**
 * Splits a command line into chained stages separated by &&, ||, or ;
 * strictly ignoring operators inside quotes.
 * Supports shell parameter: in cmd, single & is sequence operator, and ; is literal text.
 */
export function splitChainedCommandLine(input: string, shell: 'bash' | 'cmd' = 'bash'): ChainedStage[] {
  const stages: ChainedStage[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;

  let i = 0;
  while (i < input.length) {
    const char = input[i];

    if (escaped) {
      current += char;
      escaped = false;
      i++;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      current += char;
      i++;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
      continue;
    }

    // Check for operators only outside quotes
    if (!inDoubleQuote && !inSingleQuote) {
      if (char === '&' && input[i + 1] === '&') {
        stages.push({ commandLine: current.trim(), nextOp: '&&' });
        current = '';
        i += 2;
        continue;
      }
      if (char === '|' && input[i + 1] === '|') {
        stages.push({ commandLine: current.trim(), nextOp: '||' });
        current = '';
        i += 2;
        continue;
      }
      if (shell === 'cmd' && char === '&' && input[i + 1] !== '&' && input[i - 1] !== '>') {
        stages.push({ commandLine: current.trim(), nextOp: ';' });
        current = '';
        i++;
        continue;
      }
      if (shell === 'bash' && char === ';') {
        stages.push({ commandLine: current.trim(), nextOp: ';' });
        current = '';
        i++;
        continue;
      }
    }

    current += char;
    i++;
  }

  if (current.trim().length > 0 || stages.length > 0) {
    stages.push({ commandLine: current.trim() });
  }

  return stages.filter(s => s.commandLine.length > 0);
}

/**
 * Parses a single command stage, extracting stderr and stdout redirects if present outside quotes
 */
export function parseSingleCommand(cmdStr: string): ParsedCommand {
  const extracted = extractStderrRedirect(cmdStr);
  const trimmed = extracted.body.trim();
  const stderrRedirect = extracted.stderr;

  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;
  let redirectIndex = -1;
  let redirectType: '>' | '>>' = '>';

  // Find stdout redirect operators outside quotes
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inDoubleQuote && !inSingleQuote) {
      if (char === '>' && trimmed[i + 1] === '>') {
        redirectIndex = i;
        redirectType = '>>';
        break;
      } else if (char === '>') {
        redirectIndex = i;
        redirectType = '>';
        break;
      }
    }
  }

  let body = trimmed;
  let redirect: { type: '>' | '>>'; target: string } | undefined;
  let leftoverArgs: string[] = [];

  if (redirectIndex !== -1) {
    // If preceded by 1 (e.g. 1> or 1>>), strip the 1
    let cutPos = redirectIndex;
    if (cutPos > 0 && trimmed[cutPos - 1] === '1' && (cutPos === 1 || /\s/.test(trimmed[cutPos - 2]))) {
      cutPos--;
    }
    body = trimmed.slice(0, cutPos).trim();
    const after = trimmed.slice(redirectIndex + (redirectType === '>>' ? 2 : 1)).trim();
    const targetTokens = tokenizeArgs(after);
    if (targetTokens.length > 0) {
      redirect = {
        type: redirectType,
        target: targetTokens[0],
      };
      if (targetTokens.length > 1) {
        leftoverArgs = targetTokens.slice(1);
      }
    }
  }

  const tokens = tokenizeArgs(body);
  const name = tokens.length > 0 ? tokens[0] : '';
  const args = tokens.slice(1);
  if (leftoverArgs.length > 0) {
    args.push(...leftoverArgs);
  }

  return {
    raw: cmdStr.trim(),
    name,
    args,
    redirect,
    stderrRedirect,
  };
}

/**
 * Parses a piped line (e.g. "cat /var/log/syslog | grep error | wc -l")
 * ignoring pipes that are inside quotes or double pipes (||)
 */
export function parsePipelinedLine(line: string): ParsedCommand[] {
  const stages: string[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      current += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    // Only split on single pipe outside quotes (not part of ||)
    if (char === '|' && !inDoubleQuote && !inSingleQuote) {
      if (line[i + 1] === '|') {
        // Skip over the || pair
        current += '||';
        i++;
        continue;
      }
      stages.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim().length > 0) {
    stages.push(current);
  }

  return stages.map(stage => parseSingleCommand(stage));
}
