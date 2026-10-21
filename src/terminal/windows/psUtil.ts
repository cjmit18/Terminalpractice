// Shared helpers for PowerShell cmdlets: parameter binding and Windows PowerShell 5.1 error blocks.

export interface PsParams {
  named: Map<string, string | true>;
  positional: string[];
}

/**
 * Binds -Name value / -Switch parameters. `spec` maps canonical names to 'value' or 'switch';
 * like PowerShell, a unique prefix (-Rec for -Recurse) and any letter case are accepted.
 * `aliases` maps extra names (e.g. Head -> TotalCount).
 */
export function bindParams(args: string[], spec: Record<string, 'value' | 'switch'>, aliases: Record<string, string> = {}): PsParams | string {
  const named = new Map<string, string | true>();
  const positional: string[] = [];
  const names = [...Object.keys(spec), ...Object.keys(aliases)];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = a.match(/^-([A-Za-z][\w]*)(?::(.*))?$/);
    if (!m) { positional.push(a); continue; }
    const typed = m[1].toLowerCase();
    const exact = names.find(n => n.toLowerCase() === typed);
    const candidates = exact ? [exact] : names.filter(n => n.toLowerCase().startsWith(typed));
    if (candidates.length !== 1) return m[1];
    const canonical = aliases[candidates[0]] ?? candidates[0];
    if (spec[canonical] === 'switch') named.set(canonical, true);
    else named.set(canonical, m[2] ?? args[++i] ?? '');
  }
  return { named, positional };
}

/** The red error block Windows PowerShell 5.1 prints for a terminating error. */
export function psError(
  line: string,
  cmdlet: string,
  message: string,
  category: string,
  target: string,
  exception: string,
  errorId: string
): string {
  const statement = line.trim();
  return [
    `${cmdlet ? `${cmdlet} : ` : ''}${message}`,
    'At line:1 char:1',
    `+ ${statement}`,
    `+ ${'~'.repeat(Math.max(1, statement.length))}`,
    `    + CategoryInfo          : ${category}: (${target}:String) [${cmdlet}], ${exception}`,
    `    + FullyQualifiedErrorId : ${errorId}${cmdlet ? `,Microsoft.PowerShell.Commands.${cmdlet.replace('-', '')}Command` : ''}`,
  ].join('\n');
}

/** "The term 'x' is not recognized ..." for an unknown command. */
export function psNotRecognized(line: string, name: string): string {
  const statement = line.trim();
  return [
    `${name} : The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`,
    'At line:1 char:1',
    `+ ${statement}`,
    `+ ${'~'.repeat(name.length)}`,
    `    + CategoryInfo          : ObjectNotFound: (${name}:String) [], CommandNotFoundException`,
    '    + FullyQualifiedErrorId : CommandNotFoundException',
  ].join('\n');
}

export const pathNotFound = (line: string, cmdlet: string, path: string) =>
  psError(line, cmdlet, `Cannot find path '${path}' because it does not exist.`, 'ObjectNotFound', path, 'ItemNotFoundException', 'PathNotFound');

export const accessDenied = (line: string, cmdlet: string, path: string) =>
  psError(line, cmdlet, `Access to the path '${path}' is denied.`, 'PermissionDenied', path, 'UnauthorizedAccessException', 'ItemExistsUnauthorizedAccessError');

export const badParameter = (line: string, cmdlet: string, name: string) =>
  psError(line, cmdlet, `A parameter cannot be found that matches parameter name '${name}'.`, 'InvalidArgument', '', 'ParameterBindingException', 'NamedParameterNotFound');
