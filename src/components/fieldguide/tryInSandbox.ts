import type { TerminalShell } from '../../types/terminal';
import { routeHref } from '../../lib/router';

/**
 * "Try it in the Sandbox": the command to offer is handed over in sessionStorage (this tab only),
 * and the Sandbox shows it first in its "Try:" row. Nothing runs until the learner presses Enter.
 */
const KEY = 'certsim:sandbox-try';

export interface SandboxTry {
  shell: TerminalShell;
  command: string;
}

const SHELLS: TerminalShell[] = ['bash', 'cmd', 'powershell'];

export function offerInSandbox(t: SandboxTry): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    // Storage blocked: the Sandbox still opens, just without the suggestion
  }
  window.location.hash = routeHref({ section: 'sandbox' });
}

/** The command offered, if any. Read it once on mount, then call clearSandboxTry(). */
export function peekSandboxTry(): SandboxTry | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SandboxTry>;
    if (!v || !SHELLS.includes(v.shell as TerminalShell) || typeof v.command !== 'string') return null;
    const command = v.command.trim().slice(0, 200);
    return command ? { shell: v.shell as TerminalShell, command } : null;
  } catch {
    return null;
  }
}

export function clearSandboxTry(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to do
  }
}
