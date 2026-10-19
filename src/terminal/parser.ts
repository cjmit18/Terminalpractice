/**
 * Command line tokenization and pipeline parsing
 */

export interface ParsedCommand {
  raw: string;
  name: string;
  args: string[];
  redirect?: {
    type: '>' | '>>';
    target: string;
  };
}

export interface Pipeline {
  commands: ParsedCommand[];
  operator?: '&&' | '||' | ';';
}

/**
 * Tokenizes a single command string into array of arguments handling quotes
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
 * Parses a single command stage, extracting redirects if present
 */
export function parseSingleCommand(cmdStr: string): ParsedCommand {
  const trimmed = cmdStr.trim();
  let redirect: { type: '>' | '>>'; target: string } | undefined;
  let body = trimmed;

  // Check for append >>
  const appendMatch = trimmed.match(/^(.*?)\s*>>\s*([^\s|&;]+)(.*)$/);
  if (appendMatch) {
    body = appendMatch[1] + (appendMatch[3] || '');
    redirect = { type: '>>', target: appendMatch[2] };
  } else {
    // Check for overwrite >
    const overwriteMatch = trimmed.match(/^(.*?)\s*>\s*([^\s|&;]+)(.*)$/);
    if (overwriteMatch) {
      body = overwriteMatch[1] + (overwriteMatch[3] || '');
      redirect = { type: '>', target: overwriteMatch[2] };
    }
  }

  // Remove common stderr suppressions like 2>/dev/null or 2>&1
  body = body.replace(/2>\s*\/dev\/null/g, '').replace(/2>&1/g, '').trim();

  const tokens = tokenizeArgs(body);
  const name = tokens.length > 0 ? tokens[0] : '';
  const args = tokens.slice(1);

  return {
    raw: trimmed,
    name,
    args,
    redirect,
  };
}

/**
 * Parses a piped line (e.g. "cat /var/log/syslog | grep error | wc -l")
 */
export function parsePipelinedLine(line: string): ParsedCommand[] {
  // Split on pipe (|), ignoring pipes inside quotes
  const stages: string[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;

    if (char === '|' && !inDoubleQuote && !inSingleQuote) {
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
