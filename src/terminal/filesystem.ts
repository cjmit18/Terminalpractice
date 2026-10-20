import { FileNode } from '../types/terminal';

/**
 * Converts octal permission number (e.g. 755) to symbolic string ("rwxr-xr-x")
 */
export function octalToSymbolic(octal: number): string {
  const digits = octal.toString().padStart(3, '0').slice(-3);
  const map: { [key: string]: string } = {
    '0': '---',
    '1': '--x',
    '2': '-w-',
    '3': '-wx',
    '4': 'r--',
    '5': 'r-x',
    '6': 'rw-',
    '7': 'rwx',
  };
  return digits.split('').map(d => map[d] || '---').join('');
}

/**
 * Converts symbolic permission string ("rwxr-xr-x") to octal number (755)
 */
export function symbolicToOctal(symbolic: string): number {
  if (symbolic.length !== 9) return 755;
  const chunkToDigit = (chunk: string): number => {
    let n = 0;
    if (chunk[0] === 'r') n += 4;
    if (chunk[1] === 'w') n += 2;
    if (chunk[2] === 'x' || chunk[2] === 's' || chunk[2] === 't') n += 1;
    return n;
  };
  const u = chunkToDigit(symbolic.slice(0, 3));
  const g = chunkToDigit(symbolic.slice(3, 6));
  const o = chunkToDigit(symbolic.slice(6, 9));
  return u * 100 + g * 10 + o;
}

/**
 * Applies special bits (SUID, SGID, Sticky) to a 9-char symbolic mode string
 */
export function applySpecialBits(sym: string, special: number): string {
  const c = sym.split('');
  if (special & 4) c[2] = c[2] === 'x' ? 's' : 'S';
  if (special & 2) c[5] = c[5] === 'x' ? 's' : 'S';
  if (special & 1) c[8] = c[8] === 'x' ? 't' : 'T';
  return c.join('');
}

/**
 * Extracts special bits (SUID=4, SGID=2, Sticky=1) from symbolic mode string
 */
export function getSpecialBits(sym: string): number {
  return (/[sS]/.test(sym[2] || '') ? 4 : 0) | (/[sS]/.test(sym[5] || '') ? 2 : 0) | (/[tT]/.test(sym[8] || '') ? 1 : 0);
}

/**
 * Applies octal (3 or 4 digits) or symbolic modes (e.g. u+x, g-w, o=r, u+s, +t, comma lists)
 * and returns the new symbolic string and octal value, or null if invalid
 */
export function applyChmod(current: string, mode: string): { sym: string; octal: number } | null {
  let special = getSpecialBits(current);
  let digits = String(symbolicToOctal(current)).padStart(3, '0').split('').map(Number);

  if (/^[0-7]{3,4}$/.test(mode)) {
    const m = mode.padStart(4, '0');
    special = Number(m[0]);
    digits = m.slice(1).split('').map(Number);
  } else {
    for (const clause of mode.split(',')) {
      const match = clause.match(/^([ugoa]*)([+\-=])([rwxst]*)$/);
      if (!match) return null;
      const [, whoRaw, op, perms] = match;
      const who = whoRaw === '' || whoRaw.includes('a') ? 'ugo' : whoRaw;
      const rwx = (perms.includes('r') ? 4 : 0) | (perms.includes('w') ? 2 : 0) | (perms.includes('x') ? 1 : 0);
      let sp = 0;
      if (perms.includes('s')) sp |= (who.includes('u') ? 4 : 0) | (who.includes('g') ? 2 : 0);
      if (perms.includes('t')) sp |= 1;

      ['u', 'g', 'o'].forEach((cls, i) => {
        if (!who.includes(cls)) return;
        if (op === '+') digits[i] |= rwx;
        else if (op === '-') digits[i] &= ~rwx;
        else digits[i] = rwx;
      });

      if (op === '+') special |= sp;
      else if (op === '-') special &= ~sp;
      else {
        const mask = (who.includes('u') ? 4 : 0) | (who.includes('g') ? 2 : 0) | (who.includes('o') ? 1 : 0);
        special = (special & ~mask) | sp;
      }
    }
  }

  const base = parseInt(digits.join(''), 10);
  return {
    sym: applySpecialBits(octalToSymbolic(base), special),
    octal: special * 1000 + base,
  };
}

/**
 * Retrieves supplementary groups for a user from /etc/group
 */
export function getUserGroups(fs: FileNode, user: string, primary: string): string[] {
  const lines = (getNodeAtPath(fs, '/etc/group', false)?.content ?? '').split('\n');
  const extra = lines
    .filter(l => (l.split(':')[3] ?? '').split(',').map(s => s.trim()).includes(user))
    .map(l => l.split(':')[0].trim())
    .filter(Boolean);
  return Array.from(new Set([primary, ...extra]));
}

/**
 * Checks if a user/group has permission (r, w, or x) on a given node
 */
export function checkNodePermission(
  node: FileNode,
  user: string,
  group: string | string[],
  mode: 'r' | 'w' | 'x'
): boolean {
  if (user === 'root') {
    if (mode === 'x' && node.type === 'file') {
      return (
        node.permissions.includes('x') ||
        node.permissions.includes('s') ||
        node.permissions.includes('t')
      );
    }
    return true;
  }

  const p = node.permissions.slice(-9);
  if (p.length < 9) return true;

  const groups = Array.isArray(group) ? group : [group];

  if (user === node.owner) {
    if (mode === 'r') return p[0] === 'r';
    if (mode === 'w') return p[1] === 'w';
    if (mode === 'x') return p[2] === 'x' || p[2] === 's';
  } else if (groups.includes(node.group)) {
    if (mode === 'r') return p[3] === 'r';
    if (mode === 'w') return p[4] === 'w';
    if (mode === 'x') return p[5] === 'x' || p[5] === 's';
  } else {
    if (mode === 'r') return p[6] === 'r';
    if (mode === 'w') return p[7] === 'w';
    if (mode === 'x') return p[8] === 'x' || p[8] === 't';
  }
  return false;
}

/**
 * Checks if a path can be traversed (x permission on all parent directories)
 */
export function checkPathTraversal(
  root: FileNode,
  path: string,
  user: string,
  group: string | string[],
  isWindows = false
): boolean {
  if (isWindows || user === 'root') return true;

  const parts = path.split('/').filter(Boolean);
  let current: FileNode = root;

  // Root directory traversal
  if (!checkNodePermission(current, user, group, 'x')) return false;

  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (!current.children || !current.children[seg]) return true; // caller reports "No such file or directory"
    current = current.children[seg];
    if (current.type === 'directory' && !checkNodePermission(current, user, group, 'x')) {
      return false;
    }
  }

  return true;
}

/**
 * Deep clones a file system tree
 */
export function cloneFileSystem(root: FileNode): FileNode {
  return JSON.parse(JSON.stringify(root));
}

/**
 * Normalizes a path string based on operating system convention
 */
export function normalizePath(path: string, cwd: string, isWindows: boolean): string {
  if (!path || path === '.') return cwd;

  // Handle home directory expansion
  if (path === '~') return isWindows ? 'C:\\Users\\Student' : '/home/student';
  if (path.startsWith('~/')) {
    const rel = path.slice(2);
    return isWindows ? `C:\\Users\\Student\\${rel.replace(/\//g, '\\')}` : `/home/student/${rel}`;
  }

  // Windows path handling
  if (isWindows) {
    let clean = path.replace(/\//g, '\\');
    let full = '';
    if (/^[A-Za-z]:\\/.test(clean) || clean === 'C:' || clean === 'C:\\') {
      full = clean.length === 2 ? `${clean}\\` : clean;
    } else {
      full = cwd.endsWith('\\') ? `${cwd}${clean}` : `${cwd}\\${clean}`;
    }

    const driveMatch = full.match(/^([A-Za-z]:)(.*)$/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : 'C:';
    const rest = driveMatch ? driveMatch[2] : full;

    const segments = rest.split('\\').filter(Boolean);
    const resolved: string[] = [];

    for (const seg of segments) {
      if (seg === '.') continue;
      if (seg === '..') {
        if (resolved.length > 0) resolved.pop();
      } else {
        resolved.push(seg);
      }
    }

    return `${drive}\\${resolved.join('\\')}`;
  }

  // Linux path handling
  let full = path.startsWith('/') ? path : (cwd === '/' ? `/${path}` : `${cwd}/${path}`);
  const segments = full.split('/').filter(Boolean);
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  return '/' + resolved.join('/');
}

/**
 * Finds a node at the given path in the virtual file system tree
 */
export function getNodeAtPath(root: FileNode, path: string, isWindows: boolean): FileNode | null {
  if (isWindows) {
    const clean = path.replace(/\//g, '\\');
    const driveMatch = clean.match(/^([A-Za-z]:)(.*)$/);
    const rest = driveMatch ? driveMatch[2] : clean;
    const segments = rest.split('\\').filter(Boolean);

    let current: FileNode = root;
    for (const seg of segments) {
      if (!current.children) return null;
      const lower = seg.toLowerCase();
      const matchKey = Object.keys(current.children).find(k => k.toLowerCase() === lower);
      if (!matchKey) return null;
      current = current.children[matchKey];
    }
    return current;
  }

  // Linux
  const segments = path.split('/').filter(Boolean);
  let current: FileNode = root;
  for (const seg of segments) {
    if (!current.children || !current.children[seg]) {
      return null;
    }
    current = current.children[seg];
  }
  return current;
}

/**
 * Creates a file or directory at the specified path
 */
export function createNode(
  root: FileNode,
  path: string,
  type: 'file' | 'directory',
  content = '',
  isWindows = false,
  owner = 'student',
  group = 'student',
  octal = 755
): boolean {
  const sep = isWindows ? '\\' : '/';
  const clean = isWindows ? path.replace(/\//g, '\\') : path;
  const parts = clean.split(sep).filter(Boolean);
  if (parts.length === 0) return false;

  const nodeName = parts[parts.length - 1];
  const parentPath = isWindows 
    ? clean.substring(0, clean.lastIndexOf('\\')) || 'C:\\'
    : '/' + parts.slice(0, parts.length - 1).join('/');

  const parent = getNodeAtPath(root, parentPath, isWindows);
  if (!parent || parent.type !== 'directory') return false;

  if (!parent.children) parent.children = {};

  const key = isWindows ? nodeName : nodeName;
  parent.children[key] = {
    name: nodeName,
    type,
    content: type === 'file' ? content : undefined,
    size: type === 'file' ? content.length : 4096,
    permissions: octalToSymbolic(octal),
    octal,
    owner,
    group,
    updatedAt: new Date().toISOString(),
    children: type === 'directory' ? {} : undefined,
  };

  return true;
}

/**
 * Removes a file or directory at path
 */
export function removeNode(root: FileNode, path: string, isWindows = false): boolean {
  const sep = isWindows ? '\\' : '/';
  const clean = isWindows ? path.replace(/\//g, '\\') : path;
  const parts = clean.split(sep).filter(Boolean);
  if (parts.length === 0) return false;

  const nodeName = parts[parts.length - 1];
  const parentPath = isWindows 
    ? clean.substring(0, clean.lastIndexOf('\\')) || 'C:\\'
    : '/' + parts.slice(0, parts.length - 1).join('/');

  const parent = getNodeAtPath(root, parentPath, isWindows);
  if (!parent || !parent.children) return false;

  if (isWindows) {
    const matchKey = Object.keys(parent.children).find(k => k.toLowerCase() === nodeName.toLowerCase());
    if (matchKey) {
      delete parent.children[matchKey];
      return true;
    }
    return false;
  }

  if (parent.children[nodeName]) {
    delete parent.children[nodeName];
    return true;
  }
  return false;
}

/**
 * Validates read access on a path for a given user/group
 */
export function canReadNode(
  root: FileNode,
  path: string,
  user: string,
  group: string | string[],
  isWindows = false
): { ok: boolean; error?: string } {
  if (isWindows || user === 'root') return { ok: true };
  if (!checkPathTraversal(root, path, user, group, isWindows)) {
    return { ok: false, error: 'Permission denied' };
  }
  const node = getNodeAtPath(root, path, isWindows);
  if (!node) return { ok: false, error: 'No such file or directory' };
  if (!checkNodePermission(node, user, group, 'r')) {
    return { ok: false, error: 'Permission denied' };
  }
  return { ok: true };
}

/**
 * Validates write access on a path for a given user/group
 */
export function canWriteNode(
  root: FileNode,
  path: string,
  user: string,
  group: string | string[],
  isWindows = false
): { ok: boolean; error?: string } {
  if (isWindows || user === 'root') return { ok: true };
  if (!checkPathTraversal(root, path, user, group, isWindows)) {
    return { ok: false, error: 'Permission denied' };
  }
  const node = getNodeAtPath(root, path, isWindows);
  if (node) {
    if (!checkNodePermission(node, user, group, 'w')) {
      return { ok: false, error: 'Permission denied' };
    }
    return { ok: true };
  }

  // File does not exist yet: check parent directory write and search permissions
  const parts = path.split('/').filter(Boolean);
  const parentPath = '/' + parts.slice(0, parts.length - 1).join('/');
  const parent = getNodeAtPath(root, parentPath, isWindows);
  if (!parent || parent.type !== 'directory') {
    return { ok: false, error: 'No such file or directory' };
  }
  if (!checkNodePermission(parent, user, group, 'w')) {
    return { ok: false, error: 'Permission denied' };
  }
  return { ok: true };
}

/**
 * Validates deletion access on a path for a given user/group (including sticky bit enforcement)
 */
export function canDeleteNode(
  root: FileNode,
  path: string,
  user: string,
  group: string | string[],
  isWindows = false
): { ok: boolean; error?: string } {
  if (isWindows || user === 'root') return { ok: true };
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { ok: false, error: 'Cannot remove root directory' };

  const parentPath = '/' + parts.slice(0, parts.length - 1).join('/');
  const parent = getNodeAtPath(root, parentPath, isWindows);
  if (!parent || parent.type !== 'directory') {
    return { ok: false, error: 'No such file or directory' };
  }

  if (!checkNodePermission(parent, user, group, 'w')) {
    return { ok: false, error: 'Permission denied' };
  }

  const node = getNodeAtPath(root, path, isWindows);
  if (!node) return { ok: false, error: 'No such file or directory' };

  // Sticky bit (t) on parent directory: only file owner or directory owner (or root) may delete
  const isSticky = parent.permissions.endsWith('t') || parent.permissions.endsWith('T');
  if (isSticky) {
    if (user !== node.owner && user !== parent.owner) {
      return { ok: false, error: 'Operation not permitted' };
    }
  }

  return { ok: true };
}

/**
 * Creates default Linux root filesystem
 */
export function createDefaultLinuxFs(): FileNode {
  return {
    name: '/',
    type: 'directory',
    permissions: 'rwxr-xr-x',
    octal: 755,
    owner: 'root',
    group: 'root',
    updatedAt: '2026-10-19T00:00:00Z',
    children: {
      bin: {
        name: 'bin',
        type: 'directory',
        permissions: 'rwxr-xr-x',
        octal: 755,
        owner: 'root',
        group: 'root',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {
          bash: { name: 'bash', type: 'file', content: '#!/bin/bash binary', permissions: 'rwxr-xr-x', octal: 755, owner: 'root', group: 'root', updatedAt: '2026-10-19T00:00:00Z' },
          ls: { name: 'ls', type: 'file', content: 'ls binary', permissions: 'rwxr-xr-x', octal: 755, owner: 'root', group: 'root', updatedAt: '2026-10-19T00:00:00Z' },
          cat: { name: 'cat', type: 'file', content: 'cat binary', permissions: 'rwxr-xr-x', octal: 755, owner: 'root', group: 'root', updatedAt: '2026-10-19T00:00:00Z' },
          systemctl: { name: 'systemctl', type: 'file', content: 'systemctl binary', permissions: 'rwxr-xr-x', octal: 755, owner: 'root', group: 'root', updatedAt: '2026-10-19T00:00:00Z' }
        }
      },
      etc: {
        name: 'etc',
        type: 'directory',
        permissions: 'rwxr-xr-x',
        octal: 755,
        owner: 'root',
        group: 'root',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {
          passwd: {
            name: 'passwd',
            type: 'file',
            permissions: 'rw-r--r--',
            octal: 644,
            owner: 'root',
            group: 'root',
            updatedAt: '2026-10-19T00:00:00Z',
            content: `root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nbin:x:2:2:bin:/bin:/usr/sbin/nologin\nsys:x:3:3:sys:/dev:/usr/sbin/nologin\nstudent:x:1000:1000:Student User,,,:/home/student:/bin/bash\nnginx:x:1001:1001:Nginx Web Server,,,:/var/www:/usr/sbin/nologin`
          },
          group: {
            name: 'group',
            type: 'file',
            permissions: 'rw-r--r--',
            octal: 644,
            owner: 'root',
            group: 'root',
            updatedAt: '2026-10-19T00:00:00Z',
            content: `root:x:0:\nadm:x:4:syslog,student\nsudo:x:27:student\nstudent:x:1000:\nfinance:x:1002:\ndevelopers:x:1003:\nnginx:x:1001:`
          },
          shadow: {
            name: 'shadow',
            type: 'file',
            permissions: '----------',
            octal: 0,
            owner: 'root',
            group: 'shadow',
            updatedAt: '2026-10-19T00:00:00Z',
            content: `root:$6$rounds=4096$salt$hashedpassword:19000:0:99999:7:::\nstudent:$6$rounds=4096$salt$studentpasshash:19000:0:99999:7:::\nnginx:*:19000:0:99999:7:::`
          },
          fstab: {
            name: 'fstab',
            type: 'file',
            permissions: 'rw-r--r--',
            octal: 644,
            owner: 'root',
            group: 'root',
            updatedAt: '2026-10-19T00:00:00Z',
            content: `UUID=8d6a8f1e-3a9b-4c22-b5e1-8f432176b912 / ext4 defaults,noatime 0 1\nUUID=4a7b9c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d /boot ext4 defaults 0 2\nUUID=12345678-90ab-cdef-1234-567890abcdef swap swap defaults 0 0`
          },
          resolv: {
            name: 'resolv.conf',
            type: 'file',
            permissions: 'rw-r--r--',
            octal: 644,
            owner: 'root',
            group: 'root',
            updatedAt: '2026-10-19T00:00:00Z',
            content: `nameserver 1.1.1.1\nnameserver 8.8.8.8\nsearch corp.internal`
          },
          hosts: {
            name: 'hosts',
            type: 'file',
            permissions: 'rw-r--r--',
            octal: 644,
            owner: 'root',
            group: 'root',
            updatedAt: '2026-10-19T00:00:00Z',
            content: `127.0.0.1 localhost\n127.0.1.1 lpi-lab\n192.168.1.10 gateway.corp.internal\n192.168.1.50 fileserver.corp.internal`
          }
        }
      },
      home: {
        name: 'home',
        type: 'directory',
        permissions: 'rwxr-xr-x',
        octal: 755,
        owner: 'root',
        group: 'root',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {
          student: {
            name: 'student',
            type: 'directory',
            permissions: 'rwxr-xr-x',
            octal: 755,
            owner: 'student',
            group: 'student',
            updatedAt: '2026-10-19T00:00:00Z',
            children: {
              'notes.txt': {
                name: 'notes.txt',
                type: 'file',
                permissions: 'rw-r--r--',
                octal: 644,
                owner: 'student',
                group: 'student',
                updatedAt: '2026-10-19T00:00:00Z',
                content: `LPIC-1 Study Notes:\n- Remember: chmod 755 gives rwxr-xr-x\n- Umask 022 gives default 755 for dirs and 644 for files\n- Tar syntax: c=create, x=extract, v=verbose, z=gzip, f=file`
              },
              scripts: {
                name: 'scripts',
                type: 'directory',
                permissions: 'rwxr-xr-x',
                octal: 755,
                owner: 'student',
                group: 'student',
                updatedAt: '2026-10-19T00:00:00Z',
                children: {
                  'backup.sh': {
                    name: 'backup.sh',
                    type: 'file',
                    permissions: 'rwxr-xr-x',
                    octal: 755,
                    owner: 'student',
                    group: 'student',
                    updatedAt: '2026-10-19T00:00:00Z',
                    content: `#!/bin/bash\necho "Running nightly backup..."\ntar -czf /tmp/backup.tar.gz /home/student/notes.txt`
                  }
                }
              }
            }
          }
        }
      },
      var: {
        name: 'var',
        type: 'directory',
        permissions: 'rwxr-xr-x',
        octal: 755,
        owner: 'root',
        group: 'root',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {
          log: {
            name: 'log',
            type: 'directory',
            permissions: 'rwxr-xr-x',
            octal: 755,
            owner: 'root',
            group: 'root',
            updatedAt: '2026-10-19T00:00:00Z',
            children: {
              'syslog': {
                name: 'syslog',
                type: 'file',
                permissions: 'rw-r-----',
                octal: 640,
                owner: 'root',
                group: 'adm',
                updatedAt: '2026-10-19T00:00:00Z',
                content: `Oct 19 10:14:02 lpi-lab systemd[1]: Started Daily apt upgrade and clean activities.\nOct 19 10:15:30 lpi-lab kernel: [ 45.120] e1000e: eth0 NIC Link is Up 1000 Mbps Full Duplex\nOct 19 10:20:11 lpi-lab sshd[2410]: Server listening on 0.0.0.0 port 22.\nOct 19 10:21:44 lpi-lab nginx[3100]: [error] 3100#3100: bind() to 0.0.0.0:80 failed (98: Address already in use)`
              },
              'auth.log': {
                name: 'auth.log',
                type: 'file',
                permissions: 'rw-r-----',
                octal: 640,
                owner: 'root',
                group: 'adm',
                updatedAt: '2026-10-19T00:00:00Z',
                content: `Oct 19 09:00:01 lpi-lab CRON[1844]: pam_unix(cron:session): session opened for user root\nOct 19 09:12:33 lpi-lab sshd[1902]: Failed password for invalid user admin from 198.51.100.44 port 54122 ssh2\nOct 19 09:12:35 lpi-lab sshd[1904]: Failed password for invalid user admin from 198.51.100.44 port 54124 ssh2\nOct 19 09:12:38 lpi-lab sshd[1906]: Failed password for root from 198.51.100.44 port 54128 ssh2\nOct 19 09:15:20 lpi-lab sudo: student : TTY=pts/0 ; PWD=/home/student ; USER=root ; COMMAND=/usr/bin/apt update`
              }
            }
          }
        }
      },
      root: {
        name: 'root',
        type: 'directory',
        permissions: 'rwx------',
        octal: 700,
        owner: 'root',
        group: 'root',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {
          '.bashrc': {
            name: '.bashrc',
            type: 'file',
            permissions: 'rw-r--r--',
            octal: 644,
            owner: 'root',
            group: 'root',
            updatedAt: '2026-10-19T00:00:00Z',
            content: '# ~/.bashrc: executed by bash(1) for non-login shells.\nexport PATH=$PATH:/usr/sbin',
          }
        }
      },
      tmp: {
        name: 'tmp',
        type: 'directory',
        permissions: 'rwxrwxrwt',
        octal: 1777,
        owner: 'root',
        group: 'root',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {}
      }
    }
  };
}

/**
 * Creates default Windows root filesystem
 */
export function createDefaultWindowsFs(): FileNode {
  return {
    name: 'C:',
    type: 'directory',
    permissions: 'rwxr-xr-x',
    octal: 755,
    owner: 'SYSTEM',
    group: 'Administrators',
    updatedAt: '2026-10-19T00:00:00Z',
    children: {
      Windows: {
        name: 'Windows',
        type: 'directory',
        permissions: 'rwxr-xr-x',
        octal: 755,
        owner: 'SYSTEM',
        group: 'Administrators',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {
          System32: {
            name: 'System32',
            type: 'directory',
            permissions: 'rwxr-xr-x',
            octal: 755,
            owner: 'SYSTEM',
            group: 'Administrators',
            updatedAt: '2026-10-19T00:00:00Z',
            children: {
              drivers: {
                name: 'drivers',
                type: 'directory',
                permissions: 'rwxr-xr-x',
                octal: 755,
                owner: 'SYSTEM',
                group: 'Administrators',
                updatedAt: '2026-10-19T00:00:00Z',
                children: {
                  etc: {
                    name: 'etc',
                    type: 'directory',
                    permissions: 'rwxr-xr-x',
                    octal: 755,
                    owner: 'SYSTEM',
                    group: 'Administrators',
                    updatedAt: '2026-10-19T00:00:00Z',
                    children: {
                      hosts: {
                        name: 'hosts',
                        type: 'file',
                        permissions: 'rw-r--r--',
                        octal: 644,
                        owner: 'SYSTEM',
                        group: 'Administrators',
                        updatedAt: '2026-10-19T00:00:00Z',
                        content: `# Copyright (c) 1993-2009 Microsoft Corp.\n127.0.0.1       localhost\n::1             localhost\n192.168.1.10    dc01.corp.local`
                      }
                    }
                  }
                }
              },
              GroupPolicy: {
                name: 'GroupPolicy',
                type: 'directory',
                permissions: 'rwxr-xr-x',
                octal: 755,
                owner: 'SYSTEM',
                group: 'Administrators',
                updatedAt: '2026-10-19T00:00:00Z',
                children: {
                  'gpt.ini': {
                    name: 'gpt.ini',
                    type: 'file',
                    permissions: 'rw-r--r--',
                    octal: 644,
                    owner: 'SYSTEM',
                    group: 'Administrators',
                    updatedAt: '2026-10-19T00:00:00Z',
                    content: `[General]\nVersion=65538\ndisplayName=Default Domain Policy`
                  }
                }
              }
            }
          }
        }
      },
      Users: {
        name: 'Users',
        type: 'directory',
        permissions: 'rwxr-xr-x',
        octal: 755,
        owner: 'SYSTEM',
        group: 'Administrators',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {
          Administrator: {
            name: 'Administrator',
            type: 'directory',
            permissions: 'rwx------',
            octal: 700,
            owner: 'Administrator',
            group: 'Administrators',
            updatedAt: '2026-10-19T00:00:00Z',
            children: {}
          },
          Student: {
            name: 'Student',
            type: 'directory',
            permissions: 'rwxr-xr-x',
            octal: 755,
            owner: 'Student',
            group: 'Users',
            updatedAt: '2026-10-19T00:00:00Z',
            children: {
              Desktop: {
                name: 'Desktop',
                type: 'directory',
                permissions: 'rwxr-xr-x',
                octal: 755,
                owner: 'Student',
                group: 'Users',
                updatedAt: '2026-10-19T00:00:00Z',
                children: {
                  'TroubleTicket.txt': {
                    name: 'TroubleTicket.txt',
                    type: 'file',
                    permissions: 'rw-r--r--',
                    octal: 644,
                    owner: 'Student',
                    group: 'Users',
                    updatedAt: '2026-10-19T00:00:00Z',
                    content: `TICKET #8491: Sales Workstation Network Unreachable\nPriority: High\nUser reported intermittent error connecting to internal ERP server.\nPlease review IP configuration, gateway, DNS settings, and verify connectivity.`
                  }
                }
              },
              Documents: {
                name: 'Documents',
                type: 'directory',
                permissions: 'rwxr-xr-x',
                octal: 755,
                owner: 'Student',
                group: 'Users',
                updatedAt: '2026-10-19T00:00:00Z',
                children: {}
              }
            }
          }
        }
      },
      Logs: {
        name: 'Logs',
        type: 'directory',
        permissions: 'rwxr-xr-x',
        octal: 755,
        owner: 'SYSTEM',
        group: 'Administrators',
        updatedAt: '2026-10-19T00:00:00Z',
        children: {
          'CBS.log': {
            name: 'CBS.log',
            type: 'file',
            permissions: 'rw-r--r--',
            octal: 644,
            owner: 'SYSTEM',
            group: 'Administrators',
            updatedAt: '2026-10-19T00:00:00Z',
            content: `2026-10-19 09:30:11, Info CBS Starting TrustedInstaller initialization.\n2026-10-19 09:30:14, Info CBS Loaded Servicing Stack v10.0.22621.1\n2026-10-19 09:30:18, Info CBS Checking System File Catalog integrity.`
          }
        }
      }
    }
  };
}
