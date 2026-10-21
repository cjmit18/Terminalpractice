import { LINUX_DOCS } from './linuxDocs';
import { CMD_DOCS } from './cmdDocs';
import { PS_DOCS } from './psDocs';
import { CmdDoc, LinuxDoc, PsDoc } from './types';

export { LINUX_DOCS, CMD_DOCS, PS_DOCS };
export type { CmdDoc, LinuxDoc, PsDoc };

/** Every name (page name or alias) a Linux doc answers to. */
export const linuxNames = (d: LinuxDoc): string[] => [d.name, ...(d.aliases ?? [])];

/** Docs for a command name, in man's default section order (1, 8, then 5). */
export function linuxDocsFor(name: string): LinuxDoc[] {
  const order = [1, 8, 5];
  return LINUX_DOCS.filter(d => linuxNames(d).includes(name))
    .sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
}

/** The doc describing a runnable command (never a section 5 file format). */
export function linuxCommandDoc(name: string): LinuxDoc | undefined {
  return linuxDocsFor(name).find(d => d.section !== 5 && !d.pageOnly);
}

export function cmdDoc(name: string): CmdDoc | undefined {
  const n = name.toLowerCase();
  return CMD_DOCS.find(d => d.name === n || d.aliases?.includes(n));
}

/** A PowerShell doc by cmdlet name or alias (case-insensitive). */
export function psDoc(name: string): PsDoc | undefined {
  const n = name.toLowerCase();
  return PS_DOCS.find(d => d.name.toLowerCase() === n || d.aliases.includes(n));
}
