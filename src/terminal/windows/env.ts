import { SystemState } from '../../types/terminal';
import { WindowsContext, WindowsResult, cmdCommands } from './context';

// CMD environment variables: defaults every Windows session has, %VAR% expansion, and `set`.

/** The variables a fresh Windows 11 session defines, with state.envVars layered on top. */
export function windowsEnvironment(state: SystemState): Record<string, string> {
  const user = state.currentUser;
  const profile = `C:\\Users\\${user}`;
  const defaults: Record<string, string> = {
    ALLUSERSPROFILE: 'C:\\ProgramData',
    APPDATA: `${profile}\\AppData\\Roaming`,
    CommonProgramFiles: 'C:\\Program Files\\Common Files',
    COMPUTERNAME: state.hostname,
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    HOMEDRIVE: 'C:',
    HOMEPATH: `\\Users\\${user}`,
    LOCALAPPDATA: `${profile}\\AppData\\Local`,
    LOGONSERVER: '\\\\DC01',
    NUMBER_OF_PROCESSORS: '4',
    OS: 'Windows_NT',
    Path: 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\',
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    ProgramData: 'C:\\ProgramData',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    PROMPT: '$P$G',
    PUBLIC: 'C:\\Users\\Public',
    SystemDrive: 'C:',
    SystemRoot: 'C:\\Windows',
    TEMP: `${profile}\\AppData\\Local\\Temp`,
    TMP: `${profile}\\AppData\\Local\\Temp`,
    USERDOMAIN: 'CORP',
    USERNAME: user,
    USERPROFILE: profile,
    windir: 'C:\\Windows',
  };
  const merged = { ...defaults };
  // Names starting with = are CMD's hidden per-drive directories and exit code, not variables
  for (const [k, v] of Object.entries(state.envVars ?? {}).filter(([k]) => !k.startsWith('='))) {
    // Names are case-insensitive: a lab's USERNAME replaces the default Username key
    for (const existing of Object.keys(merged)) if (existing.toLowerCase() === k.toLowerCase()) delete merged[existing];
    merged[k] = v;
  }
  return merged;
}

function lookup(vars: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(vars).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : vars[key];
}

/**
 * Expands %NAME% the way an interactive CMD prompt does: once, for the whole line, before
 * it is split on & and |. Undefined variables are left as typed. %CD%, %DATE%, %TIME%,
 * %ERRORLEVEL% and %RANDOM% are dynamic.
 */
export function expandCmdVariables(line: string, state: SystemState, cwd: string): string {
  const vars = windowsEnvironment(state);
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const dynamic: Record<string, () => string> = {
    cd: () => cwd,
    date: () => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]} ${p2(now.getMonth() + 1)}/${p2(now.getDate())}/${now.getFullYear()}`,
    time: () => `${String(now.getHours()).padStart(2, ' ')}:${p2(now.getMinutes())}:${p2(now.getSeconds())}.00`,
    errorlevel: () => state.envVars?.['=ExitCode'] ?? '0',
    random: () => String(Math.floor(Math.random() * 32768)),
  };
  return line.replace(/%([^%\s=]+)%/g, (whole, name: string) => {
    const set = lookup(vars, name);
    if (set !== undefined && set !== '') return set;
    const dyn = dynamic[name.toLowerCase()];
    return dyn ? dyn() : whole;
  });
}

/** Commands that leave %ERRORLEVEL% as it was when they succeed. */
const KEEPS_ERRORLEVEL = new Set(['echo', 'echo.', 'rem', 'cls', 'set', 'title', 'prompt', 'pushd', 'popd']);

/** Records a CMD command's exit code for %ERRORLEVEL% (kept in the hidden =ExitCode variable). */
export function setErrorLevel(state: SystemState, command: string, exitCode: number): void {
  if (exitCode === 0 && KEEPS_ERRORLEVEL.has(command.toLowerCase())) return;
  state.envVars = { ...(state.envVars ?? {}), '=ExitCode': String(exitCode) };
}

/** Expands $env:NAME in a PowerShell line. */
export function expandPowerShellEnv(line: string, state: SystemState): string {
  const vars = windowsEnvironment(state);
  let result = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length;) {
    const ch = line[i];
    if (ch === '`' && i + 1 < line.length) {
      result += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      result += ch;
      i++;
      continue;
    }
    if (ch === '$' && quote !== "'") {
      const match = line.slice(i).match(/^\$env:([A-Za-z_][\w()]*)/i);
      if (match) {
        const value = lookup(vars, match[1]) ?? '';
        const escaped = value.replace(/[`"]/g, c => `\`${c}`);
        result += quote === '"' ? escaped : `"${escaped}"`;
        i += match[0].length;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

/** Integer arithmetic for `set /a`: + - * / % unary minus and parentheses; names read variables. */
function evalArithmetic(expr: string, vars: Record<string, string>): number | null {
  const toks = expr.match(/\d+|[A-Za-z_]\w*|[-+*/%()]|\S/g) ?? [];
  let i = 0;
  const atom = (): number => {
    const t = toks[i++];
    if (t === undefined) throw new Error();
    if (t === '(') { const v = sum(); if (toks[i++] !== ')') throw new Error(); return v; }
    if (t === '-') return -atom();
    if (t === '+') return atom();
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (/^[A-Za-z_]/.test(t)) return parseInt(lookup(vars, t) ?? '0', 10) || 0;
    throw new Error();
  };
  const product = (): number => {
    let v = atom();
    while (toks[i] === '*' || toks[i] === '/' || toks[i] === '%') {
      const op = toks[i++];
      const r = atom();
      if (op !== '*' && r === 0) throw new Error();
      v = op === '*' ? v * r : op === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (toks[i] === '+' || toks[i] === '-') v = toks[i++] === '+' ? v + product() : v - product();
    return v;
  };
  try {
    const v = sum();
    return i === toks.length ? v : null;
  } catch {
    return null;
  }
}

function setVar(ctx: WindowsContext, name: string, value: string) {
  const vars = { ...(ctx.state.envVars ?? {}) };
  for (const k of Object.keys(vars)) if (k.toLowerCase() === name.toLowerCase()) delete vars[k];
  // An empty value is kept as a tombstone so clearing a default variable hides it too
  vars[name] = value;
  ctx.state.envVars = vars;
}

function set(ctx: WindowsContext): WindowsResult {
  const text = ctx.args.join(' ').trim();
  const vars = Object.fromEntries(Object.entries(windowsEnvironment(ctx.state)).filter(([, v]) => v !== ''));
  if (text === '') {
    const names = Object.keys(vars).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return ctx.ok(names.map(n => `${n}=${vars[n]}`).join('\r\n'));
  }
  if (/^\/a\b/i.test(text)) {
    const expr = text.slice(2).trim().replace(/^"(.*)"$/, '$1');
    const m = expr.match(/^([A-Za-z_]\w*)\s*([+\-*/%]?)=(.*)$/);
    const target = m?.[1];
    const body = m ? (m[2] ? `${m[1]} ${m[2]} (${m[3]})` : m[3]) : expr;
    const value = evalArithmetic(body, vars);
    if (value === null) return ctx.fail('Missing operand.');
    if (target) setVar(ctx, target, String(value));
    return ctx.ok(String(value));
  }
  if (/^\/p\b/i.test(text)) return ctx.fail('The syntax of the command is incorrect.');
  const assign = text.match(/^"?([^=]+)=(.*?)"?$/);
  if (assign) {
    setVar(ctx, assign[1], assign[2]);
    return ctx.ok();
  }
  const matches = Object.keys(vars)
    .filter(n => n.toLowerCase().startsWith(text.toLowerCase()))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (matches.length === 0) return ctx.fail(`Environment variable ${text} not defined`);
  return ctx.ok(matches.map(n => `${n}=${vars[n]}`).join('\r\n'));
}

cmdCommands.register('set', set);
