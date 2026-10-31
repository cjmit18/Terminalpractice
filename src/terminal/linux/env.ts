import { FileNode, SystemState } from '../../types/terminal';
import { getNodeAtPath } from '../filesystem';

// Shell variables as bash sees them: the session's envVars plus the ones bash and login set itself.

/**
 * Machine settings the simulator keeps in envVars although they are not shell variables: the default systemd
 * target and the system time zone. A subshell (a pipeline stage, su -c) changes them for real, and env and
 * printenv never show them.
 */
export const MACHINE_SETTINGS = ['SYSTEMD_DEFAULT_TARGET', 'SYSTEM_TIMEZONE'] as const;

/** This shell's variables, with the machine settings as `after` left them */
export function keepMachineSettings(shell: Record<string, string>, after: Record<string, string> | undefined): Record<string, string> {
  const out = { ...shell };
  for (const key of MACHINE_SETTINGS) {
    if (after && key in after) out[key] = after[key];
    else delete out[key];
  }
  return out;
}

/** The passwd row (split on ':') for a user, if any. */
export function passwdEntry(fs: FileNode, user: string): string[] | undefined {
  const content = getNodeAtPath(fs, '/etc/passwd', false)?.content ?? '';
  return content.split('\n').map(l => l.split(':')).find(r => r[0] === user);
}

/** Home directory of a user from /etc/passwd (root and the default accounts fall back sensibly). */
export function homeOf(fs: FileNode, user: string): string | undefined {
  const entry = passwdEntry(fs, user);
  if (entry?.[5]) return entry[5];
  if (user === 'root') return '/root';
  return entry ? `/home/${user}` : undefined;
}

/** PID of the interactive shell: the user's bash process in the process table. */
export function shellPid(state: SystemState): number {
  const own = state.processes.find(p => p.command === 'bash' && p.user === state.currentUser)
    ?? state.processes.find(p => p.command === 'bash');
  return own?.pid ?? 2100;
}

/** HOME follows the current user: su and sudo -i switch it, as login does. */
function currentHome(fs: FileNode, state: SystemState): string {
  const env = state.envVars ?? {};
  const original = env.USER ?? 'student';
  if (state.currentUser === original && env.HOME) return env.HOME;
  return homeOf(fs, state.currentUser) ?? (state.currentUser === 'root' ? '/root' : `/home/${state.currentUser}`);
}

/**
 * Looks up a shell variable. Special parameters ($? $$ $0 $RANDOM), the login variables
 * (USER, LOGNAME, HOME) and bash's own (HOSTNAME, PWD, UID) are always set.
 */
export function shellVariable(name: string, cwd: string, fs: FileNode, state: SystemState): string | undefined {
  const env = state.envVars ?? {};
  switch (name) {
    case '?': return String(state.lastExitCode ?? 0);
    case '$': return String(shellPid(state));
    case '0': return 'bash';
    case '#': return '0';
    case '-': return 'himBHs';
    case 'RANDOM': return String(Math.floor(Math.random() * 32768));
    case 'USER': case 'LOGNAME': return state.currentUser;
    case 'HOME': return currentHome(fs, state);
    case 'HOSTNAME': return state.hostname;
    case 'PWD': return cwd;
    case 'UID': case 'EUID': return passwdEntry(fs, state.currentUser)?.[2] ?? (state.currentUser === 'root' ? '0' : '1000');
    case 'SHELL': return env.SHELL ?? '/bin/bash';
    case 'PATH': return env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    case 'BASH': return '/bin/bash';
    case 'IFS': return ' \t\n';
  }
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}
