import { FileNode, SystemState, TerminalShell } from '../types/terminal';
import { cloneFileSystem, getNodeAtPath, normalizePath, createNode, removeNode } from './filesystem';
import { parseSingleCommand, tokenizeArgs } from './parser';

export interface WindowsExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  newCwd: string;
  newFs: FileNode;
  newState: SystemState;
  diskpartActive?: boolean;
}

export function executeWindowsLine(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  shell: TerminalShell = 'cmd',
  isDiskpartSession = false
): WindowsExecutionResult {
  const line = rawInput.trim();
  if (!line) {
    return { stdout: '', stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state, diskpartActive: isDiskpartSession };
  }

  // Handle diskpart interactive sub-mode
  if (isDiskpartSession) {
    return handleDiskpartCommand(line, cwd, fs, state);
  }

  if (line.toLowerCase() === 'diskpart') {
    return {
      stdout: [
        'Microsoft DiskPart version 10.0.22621.1',
        'Copyright (C) 1999-2026 Microsoft Corporation.',
        'On computer: WIN-CLIENT01',
        '',
        'DISKPART> ',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      newCwd: cwd,
      newFs: fs,
      newState: state,
      diskpartActive: true,
    };
  }

  if (shell === 'powershell') {
    return executePowerShellCommand(line, cwd, fs, state);
  }

  return executeCmdCommand(line, cwd, fs, state);
}

function handleDiskpartCommand(
  line: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const lower = line.toLowerCase().trim();
  let activeState = { ...state };
  let activeFs = cloneFileSystem(fs);

  if (lower === 'exit') {
    return {
      stdout: 'Leaving DiskPart...',
      stderr: '',
      exitCode: 0,
      newCwd: cwd,
      newFs: activeFs,
      newState: activeState,
      diskpartActive: false,
    };
  }

  if (lower === 'list disk') {
    const lines = [
      '  Disk ###  Status         Size     Free     Dyn  Gpt',
      '  --------  -------------  -------  -------  ---  ---',
    ];
    activeState.disks.forEach(d => {
      const isSel = activeState.diskpartSelectedDisk === d.diskNumber ? '*' : ' ';
      const dyn = ' ';
      const gpt = d.partitionTable === 'GPT' ? '*' : ' ';
      const sizeGB = `${(d.totalSizeMB / 1024).toFixed(0)} GB`;
      const freeGB = '0 B';
      lines.push(`${isSel} Disk ${d.diskNumber}    ${d.status.padEnd(13, ' ')}  ${sizeGB.padEnd(7, ' ')}  ${freeGB.padEnd(7, ' ')}   ${dyn}    ${gpt}`);
    });
    return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
  }

  const selectDiskMatch = lower.match(/^select\s+disk\s+(\d+)$/);
  if (selectDiskMatch) {
    const dNum = parseInt(selectDiskMatch[1], 10);
    const disk = activeState.disks.find(d => d.diskNumber === dNum);
    if (!disk) {
      return { stdout: 'The disk you specified is not valid.', stderr: '', exitCode: 1, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
    }
    activeState.diskpartSelectedDisk = dNum;
    activeState.diskpartSelectedPartition = null;
    return { stdout: `Disk ${dNum} is now the selected disk.`, stderr: '', exitCode: 0, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
  }

  if (lower === 'list partition') {
    if (activeState.diskpartSelectedDisk === null) {
      return { stdout: 'There is no disk selected to list partitions.\nSelect a disk and try again.', stderr: '', exitCode: 1, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
    }
    const disk = activeState.disks.find(d => d.diskNumber === activeState.diskpartSelectedDisk);
    const lines = [
      '  Partition ###  Type              Size     Offset',
      '  -------------  ----------------  -------  -------',
    ];
    disk?.partitions.forEach(p => {
      const isSel = activeState.diskpartSelectedPartition === p.id ? '*' : ' ';
      lines.push(`${isSel} Partition ${p.id}   ${p.fsType.padEnd(16, ' ')}  ${p.sizeMB} MB   1024 KB`);
    });
    return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
  }

  if (lower.startsWith('create partition primary')) {
    if (activeState.diskpartSelectedDisk === null) {
      return { stdout: 'There is no disk selected.', stderr: '', exitCode: 1, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
    }
    const disk = activeState.disks.find(d => d.diskNumber === activeState.diskpartSelectedDisk);
    if (disk) {
      const newPartId = disk.partitions.length + 1;
      disk.partitions.push({
        id: newPartId,
        sizeMB: 250000,
        fsType: 'Unallocated',
        isPrimary: true,
      });
      activeState.diskpartSelectedPartition = newPartId;
    }
    return { stdout: 'DiskPart succeeded in creating the specified partition.', stderr: '', exitCode: 0, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
  }

  if (lower.startsWith('format')) {
    if (activeState.diskpartSelectedDisk === null) {
      return { stdout: 'There is no volume/partition selected.', stderr: '', exitCode: 1, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
    }
    const disk = activeState.disks.find(d => d.diskNumber === activeState.diskpartSelectedDisk);
    if (disk && disk.partitions.length > 0) {
      const p = disk.partitions[disk.partitions.length - 1];
      p.fsType = 'NTFS';
      p.label = 'DataDrive';
    }
    return {
      stdout: [
        '  100 percent completed',
        '',
        'DiskPart successfully formatted the volume.',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      newCwd: cwd,
      newFs: activeFs,
      newState: activeState,
      diskpartActive: true,
    };
  }

  if (lower.startsWith('assign')) {
    const letterMatch = lower.match(/letter=([a-z])/);
    const letter = letterMatch ? letterMatch[1].toUpperCase() : 'E';
    const disk = activeState.disks.find(d => d.diskNumber === activeState.diskpartSelectedDisk);
    if (disk && disk.partitions.length > 0) {
      const p = disk.partitions[disk.partitions.length - 1];
      p.driveLetter = `${letter}:`;
    }
    return {
      stdout: `DiskPart successfully assigned the drive letter or mount point.`,
      stderr: '',
      exitCode: 0,
      newCwd: cwd,
      newFs: activeFs,
      newState: activeState,
      diskpartActive: true,
    };
  }

  return {
    stdout: `Microsoft DiskPart command interpreter\nCommands available: active, assign, clean, convert, create, delete, exit, format, list, select`,
    stderr: '',
    exitCode: 0,
    newCwd: cwd,
    newFs: activeFs,
    newState: activeState,
    diskpartActive: true,
  };
}

function executeCmdCommand(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const parsed = parseSingleCommand(rawInput);
  let name = parsed.name.toLowerCase();
  const args = parsed.args;
  let activeFs = cloneFileSystem(fs);
  let activeState = { ...state };
  let activeCwd = cwd;

  switch (name) {
    case 'cls':
      return { stdout: '\x1b[2J\x1b[0;0H', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };

    case 'echo':
      return { stdout: args.join(' '), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };

    case 'cd':
    case 'chdir': {
      if (args.length === 0) {
        return { stdout: activeCwd, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      const target = args[0];
      const resolved = normalizePath(target, activeCwd, true);
      const node = getNodeAtPath(activeFs, resolved, true);
      if (!node) {
        return { stdout: '', stderr: 'The system cannot find the path specified.', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: '', stderr: '', exitCode: 0, newCwd: resolved, newFs: activeFs, newState: activeState };
    }

    case 'dir': {
      const resolved = normalizePath(args[0] || '.', activeCwd, true);
      const node = getNodeAtPath(activeFs, resolved, true);
      if (!node) {
        return { stdout: '', stderr: 'File Not Found', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }

      const lines = [
        ' Volume in drive C has no label.',
        ' Volume Serial Number is 4C19-A3F2',
        '',
        ` Directory of ${resolved}`,
        '',
        '10/19/2026  09:00 AM    <DIR>          .',
        '10/19/2026  09:00 AM    <DIR>          ..',
      ];

      const children = node.children || {};
      let fileCount = 0;
      let totalBytes = 0;
      let dirCount = 2;

      for (const [key, child] of Object.entries(children)) {
        if (child.type === 'directory') {
          dirCount++;
          lines.push(`10/19/2026  09:30 AM    <DIR>          ${key}`);
        } else {
          fileCount++;
          const sz = child.size || 0;
          totalBytes += sz;
          lines.push(`10/19/2026  09:45 AM            ${sz.toLocaleString().padStart(8, ' ')} ${key}`);
        }
      }

      lines.push(`               ${fileCount} File(s)     ${totalBytes.toLocaleString()} bytes`);
      lines.push(`               ${dirCount} Dir(s)  120,412,891,136 bytes free`);

      return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'type': {
      if (args.length === 0) {
        return { stdout: '', stderr: 'The syntax of the command is incorrect.', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      const target = normalizePath(args[0], activeCwd, true);
      const node = getNodeAtPath(activeFs, target, true);
      if (!node || node.type !== 'file') {
        return { stdout: '', stderr: 'The system cannot find the file specified.', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: node.content || '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'whoami':
      return { stdout: `CORP\\${activeState.currentUser}`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };

    case 'hostname':
      return { stdout: activeState.hostname, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };

    case 'ipconfig': {
      const showAll = args.includes('/all');
      const isFlush = args.includes('/flushdns');
      const isRelease = args.includes('/release');
      const isRenew = args.includes('/renew');

      if (isFlush) {
        activeState.dnsWorking = true;
        return {
          stdout: [
            'Windows IP Configuration',
            '',
            'Successfully flushed the DNS Resolver Cache.',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          newCwd: activeCwd,
          newFs: activeFs,
          newState: activeState,
        };
      }

      if (isRelease) {
        activeState.interfaces = activeState.interfaces.map(i => ({ ...i, ip: '0.0.0.0', gateway: '' }));
        return {
          stdout: [
            'Windows IP Configuration',
            '',
            'Ethernet adapter Ethernet0:',
            '   Connection-specific DNS Suffix  . : corp.local',
            '   IPv4 Address. . . . . . . . . . . : 0.0.0.0',
            '   Subnet Mask . . . . . . . . . . . : 0.0.0.0',
            '   Default Gateway . . . . . . . . . : ',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          newCwd: activeCwd,
          newFs: activeFs,
          newState: activeState,
        };
      }

      if (isRenew) {
        activeState.interfaces = activeState.interfaces.map(i => ({ ...i, ip: '192.168.1.145', netmask: '255.255.255.0', gateway: '192.168.1.1' }));
        activeState.gatewayWorking = true;
        return {
          stdout: [
            'Windows IP Configuration',
            '',
            'Ethernet adapter Ethernet0:',
            '   Connection-specific DNS Suffix  . : corp.local',
            '   Link-local IPv6 Address . . . . . : fe80::49b1:72c8:12e0:98f1%12',
            '   IPv4 Address. . . . . . . . . . . : 192.168.1.145',
            '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
            '   Default Gateway . . . . . . . . . : 192.168.1.1',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          newCwd: activeCwd,
          newFs: activeFs,
          newState: activeState,
        };
      }

      const iface = activeState.interfaces[0] || {
        ip: '192.168.1.145',
        netmask: '255.255.255.0',
        mac: '00-50-56-A1-2B-3C',
        gateway: '192.168.1.1',
        dns: ['192.168.1.10', '8.8.8.8'],
      };

      const lines = [
        'Windows IP Configuration',
        '',
      ];

      if (showAll) {
        lines.push(
          '   Host Name . . . . . . . . . . . . : WIN-CLIENT01',
          '   Primary Dns Suffix  . . . . . . . : corp.local',
          '   Node Type . . . . . . . . . . . . : Hybrid',
          '   IP Routing Enabled. . . . . . . . : No',
          '   WINS Proxy Enabled. . . . . . . . : No',
          '   DNS Suffix Search List. . . . . . : corp.local',
          '',
          'Ethernet adapter Ethernet0:',
          '   Connection-specific DNS Suffix  . : corp.local',
          '   Description . . . . . . . . . . . : Intel(R) 82574L Gigabit Network Connection',
          `   Physical Address. . . . . . . . . : ${iface.mac}`,
          '   DHCP Enabled. . . . . . . . . . . : Yes',
          '   Autoconfiguration Enabled . . . . : Yes',
          `   IPv4 Address. . . . . . . . . . . : ${iface.ip}(Preferred)`,
          `   Subnet Mask . . . . . . . . . . . : ${iface.netmask}`,
          `   Default Gateway . . . . . . . . . : ${iface.gateway}`,
          '   DHCP Server . . . . . . . . . . . : 192.168.1.10',
          `   DNS Servers . . . . . . . . . . . : ${iface.dns.join('\n                                       ')}`,
          '   NetBIOS over Tcpip. . . . . . . . : Enabled'
        );
      } else {
        lines.push(
          'Ethernet adapter Ethernet0:',
          '   Connection-specific DNS Suffix  . : corp.local',
          '   Link-local IPv6 Address . . . . . : fe80::49b1:72c8:12e0:98f1%12',
          `   IPv4 Address. . . . . . . . . . . : ${iface.ip}`,
          `   Subnet Mask . . . . . . . . . . . : ${iface.netmask}`,
          `   Default Gateway . . . . . . . . . : ${iface.gateway}`
        );
      }

      return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'ping': {
      const target = args.find(a => !a.startsWith('/') && !a.startsWith('-')) || '127.0.0.1';
      const out = [
        `Pinging ${target} with 32 bytes of data:`,
        `Reply from ${target}: bytes=32 time=12ms TTL=118`,
        `Reply from ${target}: bytes=32 time=11ms TTL=118`,
        `Reply from ${target}: bytes=32 time=14ms TTL=118`,
        `Reply from ${target}: bytes=32 time=12ms TTL=118`,
        '',
        `Ping statistics for ${target}:`,
        '    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),',
        'Approximate round trip times in milli-seconds:',
        '    Minimum = 11ms, Maximum = 14ms, Average = 12ms',
      ].join('\n');
      return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'tracert': {
      const target = args.find(a => !a.startsWith('/')) || '8.8.8.8';
      const out = [
        `Tracing route to ${target} over a maximum of 30 hops`,
        '',
        '  1    <1 ms    <1 ms    <1 ms  192.168.1.1 [gw.corp.local]',
        '  2     4 ms     3 ms     3 ms  10.200.0.1',
        '  3     9 ms     8 ms     8 ms  core-edge-01.isp.net [72.14.200.1]',
        `  4    12 ms    12 ms    11 ms  ${target}`,
        '',
        'Trace complete.',
      ].join('\n');
      return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'nslookup': {
      const domain = args[0] || 'corpdc.corp.local';
      const out = [
        'Server:  dc01.corp.local',
        'Address:  192.168.1.10',
        '',
        `Name:    ${domain}`,
        'Address:  192.168.1.10',
      ].join('\n');
      return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'netstat': {
      const showAno = args.some(a => a.includes('ano') || (a.includes('a') && a.includes('n') && a.includes('o')));
      const header = '  Proto  Local Address          Foreign Address        State           PID';
      const rows = [
        '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       844',
        '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
        '  TCP    192.168.1.145:49668    192.168.1.10:389       ESTABLISHED     1120',
      ];
      // Add rogue malicious process if present in state
      activeState.processes.forEach(p => {
        if (p.isMalicious && p.port) {
          rows.push(`  TCP    192.168.1.145:49811    203.0.113.88:${p.port}       ESTABLISHED     ${p.pid}`);
        }
      });
      return { stdout: `Active Connections\n\n${header}\n${rows.join('\n')}`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'tasklist': {
      const header = 'Image Name                     PID Session Name        Session#    Mem Usage\n========================= ======== ================ =========== ============';
      const rows = [
        'System Idle Process              0 Services                   0          8 K',
        'System                           4 Services                   0        148 K',
        'smss.exe                       384 Services                   0      1,120 K',
        'csrss.exe                      540 Services                   0      4,820 K',
        'winlogon.exe                   612 Console                    1      3,480 K',
        'services.exe                   684 Services                   0      8,220 K',
        'lsass.exe                      704 Services                   0     15,800 K',
        'svchost.exe                    844 Services                   0     22,400 K',
        'explorer.exe                  2140 Console                    1     48,900 K',
      ];
      activeState.processes.forEach(p => {
        const mem = `${(p.mem * 1024).toFixed(0)} K`;
        rows.push(`${p.command.padEnd(25, ' ')} ${p.pid.toString().padStart(8, ' ')} Console                    1 ${mem.padStart(12, ' ')}`);
      });
      return { stdout: `${header}\n${rows.join('\n')}`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'taskkill': {
      // Handles e.g. taskkill /F /PID 3892
      let pid: number | null = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i].toUpperCase() === '/PID' && args[i + 1]) {
          pid = parseInt(args[i + 1], 10);
        }
      }
      if (pid) {
        const proc = activeState.processes.find(p => p.pid === pid);
        if (proc) {
          activeState.processes = activeState.processes.filter(p => p.pid !== pid);
          return { stdout: `SUCCESS: The process with PID ${pid} has been terminated.`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
        return { stdout: '', stderr: `ERROR: The process "${pid}" not found.`, exitCode: 128, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: 'ERROR: Invalid syntax. Specify /PID <pid> or /IM <imagename>.', stderr: '', exitCode: 1, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'sfc': {
      if (args.includes('/scannow')) {
        activeState.sfcRepaired = true;
        activeState.systemIntegrityCorrupted = false;
        const out = [
          'Beginning system scan. This process will take some time.',
          '',
          'Beginning verification phase of system scan.',
          'Verification 100% complete.',
          '',
          'Windows Resource Protection found corrupt files and successfully repaired them.',
          'For online repairs, details are included in the CBS log file located at',
          'windir\\Logs\\CBS\\CBS.log. For example C:\\Windows\\Logs\\CBS\\CBS.log.',
        ].join('\n');
        return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: 'Microsoft (R) Windows (R) Resource Checker Version 6.0\nSyntax: SFC [/SCANNOW] [/VERIFYONLY] [/SCANFILE=<file>]', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'dism': {
      // Handles dism /online /cleanup-image /restorehealth
      activeState.dismRepaired = true;
      const out = [
        'Deployment Image Servicing and Management tool',
        'Version: 10.0.22621.1',
        '',
        'Image Version: 10.0.22621.1',
        '',
        '[==========================100.0%==========================]',
        'The restore operation completed successfully.',
        'The operation completed successfully.',
      ].join('\n');
      return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'bootrec': {
      // Handles /fixmbr, /fixboot, /rebuildbcd
      const op = args[0]?.toLowerCase() || '/fixmbr';
      return { stdout: 'The operation completed successfully.', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'gpupdate': {
      const isForce = args.includes('/force');
      const out = [
        'Updating policy...',
        '',
        'Computer Policy update has completed successfully.',
        'User Policy update has completed successfully.',
      ].join('\n');
      return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'gpresult': {
      if (args.includes('/r') || args.includes('/R')) {
        const out = [
          'Microsoft (R) Windows (R) Operating System Group Policy Result tool v2.0',
          'Copyright (C) Microsoft Corp. 1981-2001',
          '',
          'Created On 10/19/2026 at 10:30:15 AM',
          '',
          'RSOP data for CORP\\Student on WIN-CLIENT01 : Logging Mode',
          '------------------------------------------------------------',
          '',
          'OS Configuration:            Member Workstation',
          'OS Version:                  10.0.22621',
          'Site Name:                   Default-First-Site-Name',
          'Roaming Profile:             N/A',
          'Local Profile:               C:\\Users\\Student',
          'Connected over a slow link?: No',
          '',
          'COMPUTER SETTINGS',
          '------------------',
          '    CN=WIN-CLIENT01,OU=Workstations,DC=corp,DC=local',
          '    Last time Group Policy was applied: 10/19/2026 at 10:28:44 AM',
          '    Group Policy was applied from:      dc01.corp.local',
          '    Group Policy slow link threshold:   500 kbps',
          '    Domain Name:                        CORP',
          '    Domain Type:                        Windows 2016 or later',
          '',
          '    Applied Group Policy Objects',
          '    -----------------------------',
          '        Default Domain Policy',
          '        Workstation Security Baseline GPO',
          '        BitLocker Enforcement Policy',
        ].join('\n');
        return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }
      return { stdout: 'GPRESULT [/S system [/U username [/P [password]]]] [/SCOPE {user | computer}] [/R | /V | /Z] [(/X | /H) <filename> [/F]]', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    case 'net': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'user') {
        if (args.length === 1) {
          const out = [
            'User accounts for \\\\WIN-CLIENT01',
            '-------------------------------------------------------------------------------',
            'Administrator            DefaultAccount           Guest',
            'Student                  WDAGUtilityAccount',
            'The command completed successfully.',
          ].join('\n');
          return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }

        // Check for net user <name> <pass> /add
        if (args.includes('/add') || args.includes('/ADD')) {
          const newUsername = args[1];
          // Add to adUsers or local
          if (newUsername && !activeState.adUsers.find(u => u.sAMAccountName.toLowerCase() === newUsername.toLowerCase())) {
            activeState.adUsers.push({
              sAMAccountName: newUsername,
              givenName: newUsername,
              surname: 'User',
              displayName: `${newUsername} (Added via CLI)`,
              email: `${newUsername}@corp.local`,
              department: 'Operations',
              ou: 'OU=Users,DC=corp,DC=local',
              enabled: true,
              locked: false,
              passwordNeverExpires: false,
              memberOf: ['Domain Users'],
            });
          }
          return { stdout: 'The command completed successfully.', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
        }
      }

      if (sub === 'localgroup') {
        // net localgroup administrators <name> /add
        return { stdout: 'The command completed successfully.', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
      }

      return { stdout: 'The command completed successfully.', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }

    default:
      return {
        stdout: '',
        stderr: `'${name}' is not recognized as an internal or external command,\noperable program or batch file.`,
        exitCode: 9009,
        newCwd: activeCwd,
        newFs: activeFs,
        newState: activeState,
      };
  }
}

function executePowerShellCommand(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const line = rawInput.trim();
  let activeFs = cloneFileSystem(fs);
  let activeState = { ...state };
  let activeCwd = cwd;

  // Check for Test-NetConnection
  if (/^(Test-NetConnection|tnc)/i.test(line)) {
    const portMatch = line.match(/-Port\s+(\d+)/i);
    const hostMatch = line.match(/-ComputerName\s+([^\s]+)/i);
    const host = hostMatch ? hostMatch[1] : 'dc01.corp.local';
    const port = portMatch ? parseInt(portMatch[1], 10) : 80;

    const out = [
      `ComputerName           : ${host}`,
      `RemoteAddress          : 192.168.1.10`,
      `RemotePort             : ${port}`,
      `InterfaceAlias         : Ethernet0`,
      `SourceAddress          : 192.168.1.145`,
      `PingSucceeded          : True`,
      `PingReplyDetails (RTT) : 3 ms`,
      `TcpTestSucceeded       : True`,
    ].join('\n');
    return { stdout: out, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  // Check for Get-Service
  if (/^Get-Service/i.test(line)) {
    const header = 'Status   Name               DisplayName\n------   ----               -----------';
    const rows = activeState.services.map(s => {
      return `${s.status.padEnd(8, ' ')} ${s.name.padEnd(18, ' ')} ${s.displayName}`;
    });
    return { stdout: `${header}\n${rows.join('\n')}`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  // Check for Start-Service
  if (/^Start-Service/i.test(line)) {
    const match = line.match(/^Start-Service\s+(?:-Name\s+)?([^\s]+)/i);
    if (match) {
      const sName = match[1];
      const srv = activeState.services.find(s => s.name.toLowerCase() === sName.toLowerCase());
      if (srv) {
        srv.status = 'Running';
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  // Check for Stop-Service
  if (/^Stop-Service/i.test(line)) {
    const match = line.match(/^Stop-Service\s+(?:-Name\s+)?([^\s]+)/i);
    if (match) {
      const sName = match[1];
      const srv = activeState.services.find(s => s.name.toLowerCase() === sName.toLowerCase());
      if (srv) {
        srv.status = 'Stopped';
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  // Check for Get-Process
  if (/^Get-Process/i.test(line)) {
    const header = ' NPM(K)    PM(M)      WS(M)     CPU(s)      Id  SI ProcessName\n ------    -----      -----     ------      --  -- -----------';
    const rows = [
      '      9     1.85       4.20       0.12     540   0 csrss',
      '     14     5.10      14.30       1.45     704   0 lsass',
      '     22    18.50      38.90       2.10     844   0 svchost',
      '     45    64.20     120.40       8.90    2140   1 explorer',
    ];
    activeState.processes.forEach(p => {
      rows.push(`     10     ${p.mem.toFixed(2).padStart(5, ' ')}      ${(p.mem * 2).toFixed(2).padStart(5, ' ')}       ${p.cpu.toFixed(2).padStart(5, ' ')}    ${p.pid.toString().padStart(4, ' ')}   1 ${p.command}`);
    });
    return { stdout: `${header}\n${rows.join('\n')}`, stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  // Check for Stop-Process
  if (/^Stop-Process/i.test(line)) {
    const idMatch = line.match(/-Id\s+(\d+)/i) || line.match(/Stop-Process\s+(\d+)/i);
    if (idMatch) {
      const pid = parseInt(idMatch[1], 10);
      activeState.processes = activeState.processes.filter(p => p.pid !== pid);
      return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
    }
  }

  // Active Directory cmdlets
  if (/^Get-ADUser/i.test(line)) {
    const lines: string[] = [];
    activeState.adUsers.forEach(u => {
      lines.push(
        `DistinguishedName : CN=${u.displayName},${u.ou}`,
        `Enabled           : ${u.enabled}`,
        `GivenName         : ${u.givenName}`,
        `Name              : ${u.displayName}`,
        `ObjectClass       : user`,
        `SamAccountName    : ${u.sAMAccountName}`,
        `Surname           : ${u.surname}`,
        `UserPrincipalName : ${u.sAMAccountName}@corp.local`,
        ''
      );
    });
    return { stdout: lines.join('\n'), stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  if (/^New-ADUser/i.test(line)) {
    const samMatch = line.match(/-SamAccountName\s+([^\s]+)/i);
    const nameMatch = line.match(/-Name\s+"([^"]+)"|-Name\s+([^\s]+)/i);
    const pathMatch = line.match(/-Path\s+"([^"]+)"|-Path\s+([^\s]+)/i);
    const sam = samMatch ? samMatch[1] : 'newuser';
    const name = (nameMatch ? (nameMatch[1] || nameMatch[2]) : sam);
    const ou = pathMatch ? (pathMatch[1] || pathMatch[2]) : 'OU=Users,DC=corp,DC=local';

    if (!activeState.adUsers.find(u => u.sAMAccountName.toLowerCase() === sam.toLowerCase())) {
      activeState.adUsers.push({
        sAMAccountName: sam,
        givenName: name.split(' ')[0] || sam,
        surname: name.split(' ')[1] || 'User',
        displayName: name,
        email: `${sam}@corp.local`,
        department: 'Engineering',
        ou,
        enabled: true,
        locked: false,
        passwordNeverExpires: false,
        memberOf: ['Domain Users'],
      });
    }
    return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  if (/^Add-ADGroupMember/i.test(line)) {
    const identityMatch = line.match(/-Identity\s+"([^"]+)"|-Identity\s+([^\s]+)/i);
    const membersMatch = line.match(/-Members\s+"([^"]+)"|-Members\s+([^\s]+)/i);
    const groupName = identityMatch ? (identityMatch[1] || identityMatch[2]) : '';
    const memberName = membersMatch ? (membersMatch[1] || membersMatch[2]) : '';

    if (groupName && memberName) {
      const user = activeState.adUsers.find(u => u.sAMAccountName.toLowerCase() === memberName.toLowerCase());
      if (user && !user.memberOf.includes(groupName)) {
        user.memberOf.push(groupName);
      }
      const grp = activeState.adGroups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
      if (grp && !grp.members.includes(memberName)) {
        grp.members.push(memberName);
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  if (/^Unlock-ADAccount/i.test(line)) {
    const idMatch = line.match(/-Identity\s+([^\s]+)/i);
    if (idMatch) {
      const u = activeState.adUsers.find(user => user.sAMAccountName.toLowerCase() === idMatch[1].toLowerCase());
      if (u) u.locked = false;
    }
    return { stdout: '', stderr: '', exitCode: 0, newCwd: activeCwd, newFs: activeFs, newState: activeState };
  }

  // Fallback to CMD parser for common cross-shell commands (ipconfig, ping, etc.)
  return executeCmdCommand(rawInput, cwd, fs, state);
}
