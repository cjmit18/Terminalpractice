/**
 * Shapes of the built-in documentation. One record per command (or file format); the
 * renderers in this folder turn it into man pages, Info nodes, --help, `help`, /? and
 * Get-Help output, so every help command reads from the same source.
 */

export interface DocOption {
  /** As written in the man page, e.g. "-a, --all" or "-n, --lines=[-]NUM". */
  flags: string;
  desc: string;
}

export interface DocExample {
  cmd: string;
  desc: string;
}

/** Where a page sits in GNU Info (coreutils documents each program in an "invocation" node). */
export interface InfoNode {
  file: string;
  node: string;
  title: string;
  next?: string;
  prev?: string;
  up: string;
}

export interface LinuxDoc {
  /** Page name (the first name in the NAME line). */
  name: string;
  /** Other names that share this page, e.g. egrep and fgrep for grep. */
  aliases?: string[];
  /** Manual section: 1 user commands, 5 file formats, 8 system administration. */
  section: 1 | 5 | 8;
  /** One-line NAME description, lower case as in real pages (shown by whatis/apropos). */
  summary: string;
  /** SYNOPSIS lines, each starting with the command name. */
  synopsis: string[];
  /** DESCRIPTION paragraphs. The first one doubles as the --help lead line. */
  description: string[];
  options?: DocOption[];
  examples?: DocExample[];
  seeAlso?: string[];
  /** Page header centre text; defaults by section. */
  manual?: string;
  /** Page footer left text, e.g. "GNU coreutils 8.32". */
  source?: string;
  /** Exit status paragraph (used by builtins' help text). */
  exitStatus?: string;
  info?: InfoNode;
  /**
   * Bash builtin. Builtins have no man page of their own on Ubuntu (help NAME documents
   * them); `file` is true when a program of the same name also exists (/usr/bin/echo).
   */
  builtin?: {
    short: string;
    file?: boolean;
    /** Text for `help NAME` when it differs from the man page (builtins that also exist as programs). */
    help?: string[];
    options?: DocOption[];
  };
  /** Installed in /usr/sbin rather than /usr/bin. */
  sbin?: boolean;
  /** A man page only (no program in this simulator), e.g. the file formats in section 5. */
  pageOnly?: boolean;
  /** Real tools that take -h as an alias of --help. */
  dashH?: boolean;
  /** Ignores --help entirely (bash's echo, true and false builtins). */
  noHelpOption?: boolean;
}

export interface CmdDoc {
  name: string;
  aliases?: string[];
  /** The line `help` prints next to the name. */
  summary: string;
  /** Listed by CMD's own `help` (real help only lists built-ins and a few tools). */
  inHelpList: boolean;
  /** Text printed by `<command> /?` and `help <command>`. */
  usage: string;
  /** Narrower usage for a sub-command, e.g. `net user /?` or `dism /online /cleanup-image /?`. */
  topics?: Record<string, string>;
}

export interface PsParameter {
  name: string;
  type?: string;
  desc: string;
  required?: boolean;
  position?: string;
  pipeline?: boolean;
  wildcards?: boolean;
}

export interface PsExample {
  title: string;
  code: string;
  desc: string;
}

export interface PsDoc {
  name: string;
  commandType: 'Cmdlet' | 'Function';
  module: string;
  version: string;
  /** Aliases PowerShell defines for this command (all registered in the simulator). */
  aliases: string[];
  synopsis: string;
  syntax: string[];
  description: string[];
  parameters: PsParameter[];
  examples: PsExample[];
  related: string[];
  /** learn.microsoft.com path segment for the Online Version link. */
  onlinePath?: string;
}
