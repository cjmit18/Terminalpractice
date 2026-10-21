import { CommandContext } from '../types/modules';

/**
 * Checks for the two "first steps" labs (lpi-000-first-steps and win-000-first-steps).
 *
 * They are written for people who have never used a terminal, so they accept every
 * reasonable way of doing each task: ls or ls -la, dir or Get-ChildItem, man ls or
 * ls --help or help dir, and so on. Each one looks at the last command and what it printed.
 *
 * The verifier does not see the working directory, so "went into the notes folder" is
 * judged from a successful cd to a path ending in notes, or from pwd or cd printing it.
 */

export type FirstStepsShell = 'linux' | 'windows';

/** Text that is only in welcome.txt (both labs), so printing it means the file was read. */
export const WELCOME_MARKER = 'You just read a file from the command line.';

/** The command before any pipe, with surrounding quotes and spaces tidied. */
function firstCommand(command: string): string {
  return command.split('|')[0].trim().replace(/\s+/g, ' ');
}

/** Two commands joined with ; or || : the exit code no longer tells you whether the first one worked. */
const looselyChained = (command: string) => /;|\|\|/.test(command);

const unquote = (s: string) => s.replace(/^["']|["']$/g, '');

const ok = (ctx?: CommandContext): ctx is CommandContext => !!ctx && ctx.exitCode === 0;

const BASH_WHERE = /^(pwd( -[LP]+)*|echo "?\$\{?PWD\}?"?)$/;
const WIN_WHERE = /^(cd|chdir|cd\.|echo %cd%|pwd|get-location|gl)$/i;

/** Task 1: pwd (or echo $PWD; cd, Get-Location or pwd on Windows) printed the folder you are in. */
export function workingDirShown(shell: FirstStepsShell, ctx?: CommandContext): boolean {
  if (!ok(ctx) || looselyChained(ctx.command)) return false;
  const first = firstCommand(ctx.command);
  if (shell === 'linux') return BASH_WHERE.test(first) && /^\/\S*$/m.test(ctx.stdout.trim());
  return WIN_WHERE.test(first) && /[A-Z]:\\/i.test(ctx.stdout);
}

const BASH_LIST = /^(sudo )?(ls|dir|vdir|tree)( |$)/;
const WIN_LIST = /^(dir|ls|gci|get-childitem|tree)( |$)/i;

/**
 * Task 2: a listing (ls with any options, dir, Get-ChildItem, gci) showed the lab's files:
 * welcome.txt in the home folder, or next.txt if you listed the notes folder.
 */
export function folderListed(shell: FirstStepsShell, ctx?: CommandContext): boolean {
  if (!ok(ctx)) return false;
  const first = firstCommand(ctx.command);
  const lister = shell === 'linux' ? BASH_LIST : WIN_LIST;
  return lister.test(first) && /\b(welcome|next)\.txt\b/i.test(ctx.stdout);
}

/** Task 3: any command that printed welcome.txt (cat, less, head, type, Get-Content, gc ...). */
export function welcomeRead(ctx?: CommandContext): boolean {
  return ok(ctx) && /welcome/i.test(ctx.command) && ctx.stdout.includes(WELCOME_MARKER);
}

const BASH_CD = /^cd (\S*\/)?notes\/?$/;
const WIN_CD = /^(cd|chdir|set-location|sl|push-location|pushd)( \/d)?( -path)? (\S*[\\/])?notes[\\/]?$/i;

/**
 * Task 4: a cd into the notes folder worked (cd notes, cd notes/, cd ~/notes, cd .\notes,
 * Set-Location notes ...), or pwd (cd on Windows) printed a folder ending in notes.
 */
export function notesEntered(shell: FirstStepsShell, ctx?: CommandContext): boolean {
  if (!ok(ctx) || looselyChained(ctx.command)) return false;
  // With &&, a zero exit code means every part ran, so the cd at the start worked
  const first = ctx.command.split('&&')[0].trim().split(' ').filter(Boolean).map(unquote).join(' ');
  if ((shell === 'linux' ? BASH_CD : WIN_CD).test(first)) return true;
  if (!workingDirShown(shell, ctx)) return false;
  return shell === 'linux' ? /\/notes\/?\s*$/.test(ctx.stdout.trim()) : /\\notes\\?\s*$/im.test(ctx.stdout.trim());
}

const BASH_HELP = /^(man|info|whatis|apropos|help)( |$)|( |^)--help( |$)/;
const WIN_HELP = /^(help|get-help|man)( |$)|( )(\/\?|-\?)( |$)/i;

/**
 * Task 5: asked a help system about a command and got an answer: man ls, info ls, whatis ls,
 * ls --help, help cd; on Windows help dir, dir /?, Get-Help dir, Get-ChildItem -?.
 */
export function helpRead(shell: FirstStepsShell, ctx?: CommandContext): boolean {
  if (!ok(ctx) || ctx.stdout.trim() === '') return false;
  const first = firstCommand(ctx.command);
  return (shell === 'linux' ? BASH_HELP : WIN_HELP).test(first);
}
