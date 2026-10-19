import { FileNode, SystemState } from '../types/terminal';
import { 
  cloneFileSystem, 
  getNodeAtPath, 
  normalizePath, 
  createNode, 
  removeNode, 
  octalToSymbolic, 
  symbolicToOctal 
} from './filesystem';
import { parsePipelinedLine, ParsedCommand } from './parser';

export interface LinuxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  newCwd: string;
  newFs: FileNode;
  newState: SystemState;
}

export function executeLinuxLine(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): LinuxExecutionResult {
  const line = rawInput.trim();
  if (!line) {
    return { stdout: '', stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state };
  }

  // Handle chaining: e.g. "cmd1 && cmd2"
  if (line.includes('&&')) {
    const parts = line.split('&&');
    let currentCwd = cwd;
    let currentFs = fs;
    let currentState = state;
    let combinedStdout = '';

    for (const part of parts) {
      const res = executeLinuxPipeline(part.trim(), currentCwd, currentFs, currentState);
      combinedStdout += (combinedStdout ? '\n' : '') + res.stdout;
      currentCwd = res.newCwd;
      currentFs = res.newFs;
      currentState = res.newState;
      if (res.exitCode !== 0) {
        return {
          stdout: combinedStdout,
          stderr: res.stderr,
          exitCode: res.exitCode,
          newCwd: currentCwd,
          newFs: currentFs,
          newState: currentState,
        };
      }
    }
    return {
      stdout: combinedStdout,
      stderr: '',
      exitCode: 0,
      newCwd: currentCwd,
      newFs: currentFs,
      newState: currentState,
    };
  }

  return executeLinuxPipeline(line, cwd, fs, state);
}

function executeLinuxPipeline(
  pipelineStr: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): LinuxExecutionResult {
  const stages = parsePipelinedLine(pipelineStr);
  let currentInput = '';
  let activeFs = cloneFileSystem(fs);
  let activeState = { ...state };
  let currentCwd = cwd;
  let exitCode = 0;
  let stderr = '';

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isFirst = i === 0;
    const isLast = i === stages.length - 1;

    const res = executeSingleLinuxCommand(stage, currentCwd, activeFs, activeState, currentInput);
    currentCwd = res.newCwd;
    activeFs = res.newFs;
    activeState = res.newState;
    exitCode = res.exitCode;
    stderr = res.stderr;

    if (exitCode !== 0) {
      return {
        stdout: '',
        stderr: res.stderr || `Command '${stage.name}' failed with exit code ${exitCode}`,
        exitCode,
        newCwd: currentCwd,
        newFs: activeFs,
        newState: activeState,
      };
    }

    currentInput = res.stdout;

    // Handle stage redirection if last stage has > or >>
    if (isLast && stage.redirect) {
      const targetPath = normalizePath(stage.redirect.target, currentCwd, false);
      const existing = getNodeAtPath(activeFs, targetPath, false);

      if (existing && existing.type === 'file') {
        if (stage.redirect.type === '>>') {
          existing.content = (existing.content || '') + (existing.content ? '\n' : '') + currentInput;
        } else {
          existing.content = currentInput;
        }
      } else {
        createNode(activeFs, targetPath, 'file', currentInput, false, activeState.currentUser, activeState.currentGroup, 644);
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        newCwd: currentCwd,
        newFs: activeFs,
        newState: activeState,
      };
    }
  }

  return {
    stdout: currentInput,
    stderr,
    exitCode,
    newCwd: currentCwd,
    newFs: activeFs,
    newState: activeState,
  };
}

interface CommandStepResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  newCwd: string;
  newFs: FileNode;
  newState: SystemState;
}

function executeSingleLinuxCommand(
  cmd: ParsedCommand,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  stdin: string
): CommandStepResult {
  let { name, args } = cmd;
  let activeFs = fs;
  let activeState = { ...state };
  let activeCwd = cwd;

  // Handle sudo prefix
  let isSudo = false;
  if (name === 'sudo') {
    isSudo = true;
    if (args.length === 0) {
      return {
        stdout: 'usage: sudo -h | -K | -k | -V\nusage: sudo -v [-AknS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-AknS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command]',
        stderr: '',
        exitCode: 1,
        newCwd: cwd,
        newFs: fs,
        newState: state,
      };
    }
    name = args[0];
    args = args.slice(1);
  }

  // Built-in commands
  switch (name) {
    case 'pwd':
      return { stdout: activeCwd, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };

    case 'clear':
      return { stdout: '\x1b[2J\x1b[0;0H', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };

    case 'whoami':
      return { stdout: isSudo ? 'root' : activeState.currentUser, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };

    case 'id': {
      const u = isSudo ? 'root' : activeState.currentUser;
      const uid = u === 'root' ? 0 : 1000;
      const gid = u === 'root' ? 0 : 1000;
      const groups = u === 'root' 
        ? '0(root)' 
        : '1000(student),27(sudo),1002(finance)';
      return {
        stdout: `uid=${uid}(${u}) gid=${gid}(${u}) groups=${groups}`,
        stderr: '',
        exitCode: 0,
        newCwd: activeCwd,
        newFs: activeFs,
        newState: activeState,
      };
    }

    case 'hostname':
      return { stdout: activeState.hostname, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };

    case 'uname': {
      if (args.includes('-a')) {
        return {
          stdout: `Linux ${activeState.hostname} 5.15.0-101-generic #111-Ubuntu SMP x86_64 GNU/Linux`,
          stderr: '',
          exitCode: 0,
          newCwd: activeCwd,
          newFs: activeFs,
          newState: activeState,
        };
      }
      return { stdout: 'Linux', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'dmesg': {
      const logs = [
        '[    0.000000] Linux version 5.15.0-101-generic (buildd@lcy02-amd64-072) (gcc version 11.4.0)',
        '[    0.000000] Command line: BOOT_IMAGE=/vmlinuz-5.15.0-101-generic root=UUID=8d6a8f1e ro quiet splash',
        '[    0.412891] ACPI: Core revision 20210604',
        '[    1.120542] pci 0000:00:1f.2: [8086:2922] SATA AHCI controller',
        '[    2.341209] e1000e: Intel(R) PRO/1000 Network Driver',
        '[    2.341512] e1000e 0000:00:19.0 eth0: (PCI Express:2.5GT/s:Width x1) 52:54:00:12:34:56',
        '[    3.150221] systemd[1]: Inserted module \'autofs4\'',
        '[    4.201944] EXT4-fs (sda1): mounted filesystem with ordered data mode. Opts: (null)',
      ].join('\n');
      return { stdout: logs, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'lspci': {
      const devices = [
        '00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma]',
        '00:01.0 ISA bridge: Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II]',
        '00:01.1 IDE interface: Intel Corporation 82371SB PIIX3 IDE [Natoma/Triton II]',
        '00:02.0 VGA compatible controller: Red Hat, Inc. QXL paravirtual graphic card',
        '00:03.0 Ethernet controller: Intel Corporation 82540EM Gigabit Ethernet Controller (rev 02)',
        '00:04.0 USB controller: Intel Corporation 82801I (ICH9 Family) USB UHCI Controller #1',
      ].join('\n');
      return { stdout: devices, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'lsmod': {
      const mods = [
        'Module                  Size  Used by',
        'e1000e                286720  0',
        'ext4                  962560  1',
        'crc16                  16384  1 ext4',
        'mbcache                16384  1 ext4',
        'jbd2                  163840  1 ext4',
        'ahci                   45056  2',
        'libahci                49152  1 ahci',
      ].join('\n');
      return { stdout: mods, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'cd': {
      const target = args[0] || '~';
      const resolved = normalizePath(target, activeCwd, false);
      const node = getNodeAtPath(activeFs, resolved, false);
      if (!node) {
        return { stdout: '', stderr: `cd: ${target}: No such file or directory`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      if (node.type !== 'directory') {
        return { stdout: '', stderr: `cd: ${target}: Not a directory`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: resolved, newFs: activeFs, newState: activeState };
    }

    case 'ls': {
      const showAll = args.some(a => a.startsWith('-') && a.includes('a'));
      const showLong = args.some(a => a.startsWith('-') && a.includes('l'));
      const targetPath = args.find(a => !a.startsWith('-')) || activeCwd;
      const resolved = normalizePath(targetPath, activeCwd, false);
      const node = getNodeAtPath(activeFs, resolved, false);

      if (!node) {
        return { stdout: '', stderr: `ls: cannot access '${targetPath}': No such file or directory`, exitCode: 2, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }

      if (node.type === 'file') {
        if (showLong) {
          const perm = node.permissions;
          return { stdout: `${perm} 1 ${node.owner} ${node.group} ${node.size || 0} Oct 19 10:00 ${node.name}`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
        return { stdout: node.name, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }

      const children = node.children || {};
      let keys = Object.keys(children);
      if (!showAll) {
        keys = keys.filter(k => !k.startsWith('.'));
      } else {
        keys = ['.', '..', ...keys];
      }
      keys.sort();

      if (!showLong) {
        return { stdout: keys.join('  '), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }

      const lines = keys.map(k => {
        if (k === '.' || k === '..') {
          return `drwxr-xr-x 2 root root 4096 Oct 19 10:00 ${k}`;
        }
        const child = children[k];
        const prefix = child.type === 'directory' ? 'd' : '-';
        const perm = prefix + child.permissions.replace(/^[d-]/, '');
        const size = (child.size || 4096).toString().padStart(6, ' ');
        return `${perm} 1 ${child.owner.padEnd(8, ' ')} ${child.group.padEnd(8, ' ')} ${size} Oct 19 10:00 ${child.name}`;
      });

      return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'cat': {
      if (args.length === 0) {
        return { stdout: stdin, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      const outputs: string[] = [];
      for (const arg of args) {
        if (arg === '-') {
          outputs.push(stdin);
          continue;
        }
        const targetPath = normalizePath(arg, activeCwd, false);
        const node = getNodeAtPath(activeFs, targetPath, false);
        if (!node) {
          return { stdout: '', stderr: `cat: ${arg}: No such file or directory`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
        if (node.type === 'directory') {
          return { stdout: '', stderr: `cat: ${arg}: Is a directory`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
        outputs.push(node.content || '');
      }
      return { stdout: outputs.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'head': {
      let count = 10;
      let filename = '';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-n' && args[i + 1]) {
          count = parseInt(args[i + 1], 10) || 10;
          i++;
        } else if (args[i].startsWith('-') && /^\-\d+$/.test(args[i])) {
          count = parseInt(args[i].slice(1), 10) || 10;
        } else {
          filename = args[i];
        }
      }
      let content = stdin;
      if (filename) {
        const targetPath = normalizePath(filename, activeCwd, false);
        const node = getNodeAtPath(activeFs, targetPath, false);
        if (!node || node.type !== 'file') {
          return { stdout: '', stderr: `head: cannot open '${filename}'`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
        content = node.content || '';
      }
      const lines = content.split('\n').slice(0, count);
      return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'tail': {
      let count = 10;
      let filename = '';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-n' && args[i + 1]) {
          count = parseInt(args[i + 1], 10) || 10;
          i++;
        } else if (args[i].startsWith('-') && /^\-\d+$/.test(args[i])) {
          count = parseInt(args[i].slice(1), 10) || 10;
        } else {
          filename = args[i];
        }
      }
      let content = stdin;
      if (filename) {
        const targetPath = normalizePath(filename, activeCwd, false);
        const node = getNodeAtPath(activeFs, targetPath, false);
        if (!node || node.type !== 'file') {
          return { stdout: '', stderr: `tail: cannot open '${filename}'`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
        content = node.content || '';
      }
      const allLines = content.split('\n');
      const lines = allLines.slice(Math.max(0, allLines.length - count));
      return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'echo': {
      const text = args.map(arg => {
        return arg
          .replace(/\$USER/g, activeState.currentUser)
          .replace(/\$HOSTNAME/g, activeState.hostname)
          .replace(/\$HOME/g, '/home/student');
      }).join(' ');
      return { stdout: text, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'mkdir': {
      const hasP = args.includes('-p');
      const dirs = args.filter(a => !a.startsWith('-'));
      if (dirs.length === 0) {
        return { stdout: '', stderr: 'mkdir: missing operand', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      for (const d of dirs) {
        const targetPath = normalizePath(d, activeCwd, false);
        createNode(activeFs, targetPath, 'directory', '', false, activeState.currentUser, activeState.currentGroup, 755);
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'touch': {
      const files = args.filter(a => !a.startsWith('-'));
      if (files.length === 0) {
        return { stdout: '', stderr: 'touch: missing file operand', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      for (const f of files) {
        const targetPath = normalizePath(f, activeCwd, false);
        const existing = getNodeAtPath(activeFs, targetPath, false);
        if (existing) {
          existing.updatedAt = new Date().toISOString();
        } else {
          createNode(activeFs, targetPath, 'file', '', false, activeState.currentUser, activeState.currentGroup, 644);
        }
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'rm': {
      const targets = args.filter(a => !a.startsWith('-'));
      if (targets.length === 0) {
        return { stdout: '', stderr: 'rm: missing operand', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      for (const t of targets) {
        const targetPath = normalizePath(t, activeCwd, false);
        removeNode(activeFs, targetPath, false);
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'chmod': {
      // Handles e.g. chmod 750 /path/to/file or chmod +x script.sh
      if (args.length < 2) {
        return { stdout: '', stderr: 'chmod: missing operand', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      const modeArg = args[0];
      const targetPaths = args.slice(1);

      for (const p of targetPaths) {
        const resolved = normalizePath(p, activeCwd, false);
        const node = getNodeAtPath(activeFs, resolved, false);
        if (!node) {
          return { stdout: '', stderr: `chmod: cannot access '${p}': No such file or directory`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }

        if (/^[0-7]{3,4}$/.test(modeArg)) {
          const octal = parseInt(modeArg.slice(-3), 10);
          node.octal = octal;
          node.permissions = octalToSymbolic(octal);
        } else if (modeArg === '+x' || modeArg === 'u+x') {
          node.permissions = node.permissions.slice(0, 2) + 'x' + node.permissions.slice(3);
          node.octal = symbolicToOctal(node.permissions);
        } else if (modeArg === '750') {
          node.octal = 750;
          node.permissions = 'rwxr-x---';
        }
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'chown': {
      // e.g. chown root:finance /path or chown student /path
      if (args.length < 2) {
        return { stdout: '', stderr: 'chown: missing operand', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      const spec = args[0];
      const targetPaths = args.slice(1);
      const [newOwner, newGroup] = spec.split(':');

      for (const p of targetPaths) {
        const resolved = normalizePath(p, activeCwd, false);
        const node = getNodeAtPath(activeFs, resolved, false);
        if (!node) {
          return { stdout: '', stderr: `chown: cannot access '${p}': No such file or directory`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
        if (newOwner) node.owner = newOwner;
        if (newGroup) node.group = newGroup;
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'umask': {
      if (args.length === 0) {
        const maskStr = activeState.umask.toString().padStart(4, '0');
        return { stdout: maskStr, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      const val = parseInt(args[0], 8);
      if (!isNaN(val)) {
        activeState.umask = val;
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'grep': {
      let ignoreCase = false;
      let invert = false;
      let countOnly = false;
      let pattern = '';
      let fileArg = '';

      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-i') ignoreCase = true;
        else if (a === '-v') invert = true;
        else if (a === '-c') countOnly = true;
        else if (!pattern) pattern = a;
        else if (!fileArg) fileArg = a;
      }

      let content = stdin;
      if (fileArg) {
        const targetPath = normalizePath(fileArg, activeCwd, false);
        const node = getNodeAtPath(activeFs, targetPath, false);
        if (!node || node.type !== 'file') {
          return { stdout: '', stderr: `grep: ${fileArg}: No such file or directory`, exitCode: 2, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
        content = node.content || '';
      }

      const lines = content.split('\n');
      const matches = lines.filter(l => {
        let text = l;
        let p = pattern;
        if (ignoreCase) {
          text = text.toLowerCase();
          p = p.toLowerCase();
        }
        const has = text.includes(p);
        return invert ? !has : has;
      });

      if (countOnly) {
        return { stdout: matches.length.toString(), stderr: '', exitCode: matches.length > 0 ? 0 : 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }

      return {
        stdout: matches.join('\n'),
        stderr: '',
        exitCode: matches.length > 0 ? 0 : 1,
        newCwd: activeCwd,
        newFs: activeFs,
        newState: activeState,
      };
    }

    case 'awk': {
      // Basic awk field extractor e.g. awk '{print $1}' or awk -F: '{print $1}'
      let delimiter = /\s+/;
      let expr = '';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-F' && args[i + 1]) {
          delimiter = new RegExp(args[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          i++;
        } else if (args[i].startsWith('-F')) {
          delimiter = new RegExp(args[i].slice(2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        } else if (!expr) {
          expr = args[i];
        }
      }

      const match = expr.match(/\$([0-9]+)/);
      const fieldIdx = match ? parseInt(match[1], 10) : 1;

      const lines = stdin.split('\n').filter(Boolean);
      const out = lines.map(line => {
        const parts = line.split(delimiter);
        return parts[fieldIdx - 1] || '';
      });

      return { stdout: out.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'sed': {
      // Handles e.g. sed 's/foo/bar/g'
      const pattern = args[0] || '';
      const sMatch = pattern.match(/s\/(.*?)\/(.*?)\/([g]?)/);
      if (sMatch) {
        const findStr = sMatch[1];
        const replStr = sMatch[2];
        const isGlobal = sMatch[3] === 'g';
        const regex = new RegExp(findStr, isGlobal ? 'g' : '');
        const res = stdin.replace(regex, replStr);
        return { stdout: res, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: stdin, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'sort': {
      const lines = stdin.split('\n').filter(Boolean);
      const reverse = args.includes('-r');
      lines.sort((a, b) => reverse ? b.localeCompare(a) : a.localeCompare(b));
      return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'uniq': {
      const lines = stdin.split('\n').filter(Boolean);
      const withCount = args.includes('-c');
      const counts: { [key: string]: number } = {};
      const uniqueKeys: string[] = [];

      for (const line of lines) {
        if (!counts[line]) {
          counts[line] = 0;
          uniqueKeys.push(line);
        }
        counts[line]++;
      }

      const output = uniqueKeys.map(k => withCount ? `   ${counts[k]} ${k}` : k);
      return { stdout: output.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'wc': {
      let content = stdin;
      if (args.length > 0 && !args[0].startsWith('-')) {
        const targetPath = normalizePath(args[0], activeCwd, false);
        const node = getNodeAtPath(activeFs, targetPath, false);
        if (node && node.type === 'file') content = node.content || '';
      }
      const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      const words = content.trim().split(/\s+/).filter(Boolean).length;
      const bytes = content.length;

      if (args.includes('-l')) {
        return { stdout: lines.toString(), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: `${lines} ${words} ${bytes}`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'ps': {
      const showAll = args.includes('aux') || args.includes('-ef');
      const header = 'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND';
      const rows = activeState.processes.map(p => {
        return `${p.user.padEnd(8, ' ')} ${p.pid.toString().padStart(5, ' ')}  ${p.cpu.toFixed(1)}  ${p.mem.toFixed(1)}  24500  4210 ?        Ss   10:00   0:01 ${p.command}`;
      });
      return { stdout: `${header}\n${rows.join('\n')}`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'kill': {
      const pidStr = args[args.length - 1];
      const pid = parseInt(pidStr, 10);
      const procIdx = activeState.processes.findIndex(p => p.pid === pid);
      if (procIdx >= 0) {
        activeState.processes = activeState.processes.filter(p => p.pid !== pid);
        return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: '', stderr: `kill: (${pid}) - No such process`, exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'systemctl': {
      const sub = args[0] || 'status';
      const srvName = args[1] || '';

      if (sub === 'status') {
        if (!srvName) return { stdout: 'State: running\nJobs: 0 queued\nFailed: 0 units', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        if (srvName.includes('nginx')) {
          return {
            stdout: `● nginx.service - A high performance web server and a reverse proxy server\n   Loaded: loaded (/lib/systemd/system/nginx.service; enabled; vendor preset: enabled)\n   Active: active (running) since Sun 2026-10-19 10:14:00 UTC; 20min ago\n  Process: 1200 ExecStart=/usr/sbin/nginx (code=exited, status=0/SUCCESS)\n Main PID: 1201 (nginx)\n    Tasks: 2 (limit: 4614)\n   Memory: 4.8M\n   CGroup: /system.slice/nginx.service\n           ├─1201 nginx: master process /usr/sbin/nginx\n           └─1202 nginx: worker process`,
            stderr: '',
            exitCode: 0,
            newCwd: activeCwd,
            newFs: activeFs,
            newState: activeState,
          };
        }
        return { stdout: `● ${srvName}.service - Service\n   Active: active (running)`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }

      if (sub === 'restart' || sub === 'start' || sub === 'reload') {
        return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'journalctl': {
      const logs = [
        '-- Journal begins at Sun 2026-10-19 08:00:00 UTC, ends at Sun 2026-10-19 10:25:00 UTC. --',
        'Oct 19 09:30:12 lpi-lab systemd[1]: Starting Network Time Synchronization...',
        'Oct 19 09:30:13 lpi-lab systemd[1]: Started Network Time Synchronization.',
        'Oct 19 09:45:00 lpi-lab kernel: [ 120.40] EXT4-fs (sda1): re-mounted. Opts: errors=remount-ro',
        'Oct 19 10:00:22 lpi-lab sshd[1450]: Accepted publickey for student from 192.168.1.100 port 51220 ssh2',
        'Oct 19 10:15:30 lpi-lab nginx[2100]: [notice] configuration file /etc/nginx/nginx.conf test is successful',
      ].join('\n');
      return { stdout: logs, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'ip': {
      if (args[0] === 'addr' || args[0] === 'a') {
        const out = activeState.interfaces.map((iface, idx) => {
          return `${idx + 1}: ${iface.name}: <BROADCAST,MULTICAST,${iface.status}> mtu 1500 qdisc fq_codel state UP\n    link/ether ${iface.mac} brd ff:ff:ff:ff:ff:ff\n    inet ${iface.ip}/${iface.netmask === '255.255.255.0' ? '24' : '16'} brd 192.168.1.255 scope global ${iface.name}`;
        }).join('\n');
        return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      if (args[0] === 'route' || args[0] === 'r') {
        return { stdout: 'default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.105 metric 100\n192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.105', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: 'Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'ifconfig': {
      const out = activeState.interfaces.map(iface => {
        return `${iface.name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${iface.ip}  netmask ${iface.netmask}  broadcast 192.168.1.255\n        ether ${iface.mac}  txqueuelen 1000  (Ethernet)\n        RX packets 15822  bytes 12948102 (12.9 MB)\n        TX packets 11200  bytes 1840291 (1.8 MB)`;
      }).join('\n\n');
      return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'ping': {
      const host = args.find(a => !a.startsWith('-')) || 'localhost';
      const output = [
        `PING ${host} (${host === '8.8.8.8' ? '8.8.8.8' : '192.168.1.1'}) 56(84) bytes of data.`,
        `64 bytes from ${host}: icmp_seq=1 ttl=117 time=14.2 ms`,
        `64 bytes from ${host}: icmp_seq=2 ttl=117 time=13.8 ms`,
        `64 bytes from ${host}: icmp_seq=3 ttl=117 time=14.0 ms`,
        `64 bytes from ${host}: icmp_seq=4 ttl=117 time=14.1 ms`,
        '',
        `--- ${host} ping statistics ---`,
        '4 packets transmitted, 4 received, 0% packet loss, time 3004ms',
        'rtt min/avg/max/mdev = 13.811/14.025/14.212/0.141 ms',
      ].join('\n');
      return { stdout: output, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'df': {
      const out = [
        'Filesystem     Type      Size  Used Avail Use% Mounted on',
        '/dev/sda1      ext4       40G   14G   24G  37% /',
        'tmpfs          tmpfs     3.9G     0  3.9G   0% /dev/shm',
        '/dev/sda2      ext4      488M  120M  333M  27% /boot',
        '/dev/sdb1      ext4      100G   22G   73G  24% /data',
      ].join('\n');
      return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'fdisk': {
      if (args.includes('-l')) {
        const out = [
          'Disk /dev/sda: 50 GiB, 53687091200 bytes, 104857600 sectors',
          'Disk model: QEMU HARDDISK',
          'Units: sectors of 1 * 512 = 512 bytes',
          'Sector size (logical/physical): 512 bytes / 512 bytes',
          'Disklabel type: gpt',
          'Disk identifier: B7413988-E29B-4D14-884E-512E098F03C1',
          '',
          'Device        Start       End   Sectors  Size Type',
          '/dev/sda1      2048   1050623   1048576  512M EFI System',
          '/dev/sda2   1050624   9388031   8337408    4G Linux swap',
          '/dev/sda3   9388032 104855551  95467520 45.5G Linux filesystem',
        ].join('\n');
        return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: 'Usage: fdisk [options] <disk>', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'apt':
    case 'apt-get': {
      const sub = args[0];
      if (sub === 'update') {
        const out = [
          'Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease',
          'Hit:2 http://archive.ubuntu.com/ubuntu jammy-updates InRelease',
          'Hit:3 http://security.ubuntu.com/ubuntu jammy-security InRelease',
          'Reading package lists... Done',
          'Building dependency tree... Done',
          'All packages are up to date.',
        ].join('\n');
        return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      if (sub === 'install') {
        const pkg = args[1] || 'package';
        if (!activeState.installedPackages.includes(pkg)) {
          activeState.installedPackages = [...activeState.installedPackages, pkg];
        }
        const out = [
          `Reading package lists... Done`,
          `Building dependency tree... Done`,
          `The following NEW packages will be installed: ${pkg}`,
          `0 upgraded, 1 newly installed, 0 to remove.`,
          `Setting up ${pkg} (2.4.52-1ubuntu4) ...`,
          `Processing triggers for man-db ...`,
        ].join('\n');
        return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: 'apt 2.4.12 (amd64)', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'useradd': {
      // Handles useradd -m -G developers sarah
      const username = args[args.length - 1];
      if (!username || username.startsWith('-')) {
        return { stdout: '', stderr: 'useradd: missing username', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      // Add user to /etc/passwd in virtual fs
      const passwdNode = getNodeAtPath(activeFs, '/etc/passwd', false);
      if (passwdNode) {
        passwdNode.content = (passwdNode.content || '') + `\n${username}:x:1005:1005:${username}:/home/${username}:/bin/bash`;
      }
      // Create home dir
      createNode(activeFs, `/home/${username}`, 'directory', '', false, username, username, 755);
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'usermod': {
      // Handles usermod -aG developers sarah
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'tar': {
      // Handles tar -czvf /tmp/backup.tar.gz file or tar -tf
      return { stdout: 'a file.txt\na scripts/backup.sh', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'man': {
      const topic = args[0] || 'ls';
      const manPages: { [key: string]: string } = {
        chmod: 'CHMOD(1)                 User Commands                CHMOD(1)\n\nNAME\n       chmod - change file mode bits\n\nSYNOPSIS\n       chmod [OPTION]... MODE[,MODE]... FILE...\n       chmod [OPTION]... OCTAL-MODE FILE...\n\nDESCRIPTION\n       chmod changes the file mode bits of each given file according to mode.\n       Mode can be octal (e.g. 755 = rwxr-xr-x) or symbolic (u+x, g-w).\n\nLPI EXAM NOTE:\n       Octal values: 4 = Read, 2 = Write, 1 = Execute.\n       SUID = 4000, SGID = 2000, Sticky Bit = 1000.',
        tar: 'TAR(1)                   User Commands                  TAR(1)\n\nNAME\n       tar - an archiving utility\n\nSYNOPSIS\n       tar [OPTION...] [FILE]...\n\nEXAMPLES\n       tar -czvf archive.tar.gz /path    Create gzipped archive\n       tar -xzvf archive.tar.gz          Extract gzipped archive\n       tar -tvf archive.tar              List archive contents',
        grep: 'GREP(1)                  User Commands                 GREP(1)\n\nNAME\n       grep - print lines matching a pattern\n\nSYNOPSIS\n       grep [OPTIONS] PATTERN [FILE...]\n\nOPTIONS\n       -i, --ignore-case\n       -v, --invert-match\n       -c, --count\n       -n, --line-number\n       -E, --extended-regexp',
        ps: 'PS(1)                    User Commands                   PS(1)\n\nNAME\n       ps - report a snapshot of the current processes.\n\nSYNOPSIS\n       ps [options]\n\nEXAMPLES\n       ps aux    Display all running processes with user, PID, CPU, MEM\n       ps -ef    Standard Unix syntax for all process list',
      };
      return {
        stdout: manPages[topic] || `MANUAL PAGE FOR '${topic}'\nNo manual entry for ${topic} in section 1`,
        stderr: '',
        exitCode: 0,
        newCwd: activeCwd,
        newFs: activeFs,
        newState: activeState,
      };
    }

    default:
      return {
        stdout: '',
        stderr: `bash: ${name}: command not found`,
        exitCode: 127,
        newCwd: activeCwd,
        newFs: activeFs,
        newState: activeState,
      };
  }
}
