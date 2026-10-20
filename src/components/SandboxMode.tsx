import React, { useState } from 'react';
import { TerminalShell, HistoryItem, FileNode, SystemState } from '../types/terminal';
import { createDefaultLinuxFs, createDefaultWindowsFs, getNodeAtPath } from '../terminal/filesystem';
import { executeLinuxLine } from '../terminal/linuxEngine';
import { executeWindowsLine } from '../terminal/windowsEngine';
import { TerminalView } from './TerminalView';
import { Terminal, Folder, File, Cpu, Shield, HardDrive, Network, RotateCcw, ChevronRight, ChevronDown } from 'lucide-react';

export const SandboxMode: React.FC = () => {
  const [shell, setShell] = useState<TerminalShell>('bash');
  const [linuxFs, setLinuxFs] = useState<FileNode>(createDefaultLinuxFs());
  const [winFs, setWinFs] = useState<FileNode>(createDefaultWindowsFs());

  const [linuxState, setLinuxState] = useState<SystemState>({
    hostname: 'sandbox-linux',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [
      {
        name: 'eth0',
        ip: '192.168.1.105',
        netmask: '255.255.255.0',
        mac: '52:54:00:12:34:56',
        gateway: '192.168.1.1',
        dns: ['192.168.1.1', '8.8.8.8'],
        dhcpEnabled: true,
        status: 'UP' as const,
      }
    ],
    processes: [
      { pid: 1, user: 'root', cpu: 0.0, mem: 0.4, command: '/sbin/init' },
      { pid: 1200, user: 'student', cpu: 0.1, mem: 0.8, command: 'bash' },
    ],
    services: [
      { name: 'nginx', displayName: 'Nginx Web Server', status: 'Running', startType: 'Automatic' },
      { name: 'ssh', displayName: 'OpenSSH Server', status: 'Running', startType: 'Automatic' },
    ],
    disks: [
      {
        diskNumber: 0,
        totalSizeMB: 51200,
        model: 'VIRTUAL SCSI DISK',
        status: 'Online',
        partitionTable: 'GPT',
        partitions: [
          { id: 1, sizeMB: 512, fsType: 'ext4', mountPoint: '/boot', isPrimary: true },
          { id: 2, sizeMB: 50688, fsType: 'ext4', mountPoint: '/', isPrimary: true },
        ],
      }
    ],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: ['bash', 'coreutils', 'tar', 'grep', 'iproute2'],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: { USER: 'student', HOME: '/home/student' },
  });

  const [winState, setWinState] = useState<SystemState>({
    hostname: 'WIN-SANDBOX01',
    currentUser: 'Administrator',
    currentGroup: 'Administrators',
    isRootOrAdmin: true,
    umask: 0,
    interfaces: [
      {
        name: 'Ethernet0',
        ip: '192.168.1.145',
        netmask: '255.255.255.0',
        mac: '00-50-56-A1-2B-3C',
        gateway: '192.168.1.1',
        dns: ['192.168.1.10', '8.8.8.8'],
        dhcpEnabled: true,
        status: 'UP' as const,
      }
    ],
    processes: [
      { pid: 4, user: 'SYSTEM', cpu: 0.1, mem: 0.1, command: 'System' },
      { pid: 844, user: 'SYSTEM', cpu: 0.5, mem: 22.4, command: 'svchost.exe' },
      { pid: 2140, user: 'Administrator', cpu: 1.2, mem: 48.9, command: 'explorer.exe' },
    ],
    services: [
      { name: 'Spooler', displayName: 'Print Spooler', status: 'Running', startType: 'Automatic' },
      { name: 'LanmanServer', displayName: 'Server (SMB)', status: 'Running', startType: 'Automatic' },
      { name: 'W32Time', displayName: 'Windows Time', status: 'Running', startType: 'Automatic' },
    ],
    disks: [
      {
        diskNumber: 0,
        totalSizeMB: 512000,
        model: 'SAMSUNG SSD 980',
        status: 'Online',
        partitionTable: 'GPT',
        partitions: [
          { id: 1, sizeMB: 500, fsType: 'FAT32', driveLetter: '', label: 'EFI System', isPrimary: true },
          { id: 2, sizeMB: 511500, fsType: 'NTFS', driveLetter: 'C:', label: 'Windows', isPrimary: true },
        ],
      },
      {
        diskNumber: 1,
        totalSizeMB: 256000,
        model: 'Crucial SSD',
        status: 'Online',
        partitionTable: 'GPT',
        partitions: [
          { id: 1, sizeMB: 256000, fsType: 'Unallocated' },
        ],
      }
    ],
    adUsers: [
      {
        sAMAccountName: 'administrator',
        givenName: 'Admin',
        surname: 'User',
        displayName: 'Administrator',
        email: 'admin@corp.local',
        department: 'IT',
        ou: 'OU=IT,DC=corp,DC=local',
        enabled: true,
        locked: false,
        passwordNeverExpires: true,
        memberOf: ['Domain Admins'],
      }
    ],
    adGroups: [
      {
        name: 'Domain Admins',
        scope: 'Global',
        category: 'Security',
        ou: 'OU=IT,DC=corp,DC=local',
        description: 'Domain Admins',
        members: ['administrator'],
      }
    ],
    gpos: [],
    installedPackages: ['RSAT'],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: { COMPUTERNAME: 'WIN-SANDBOX01', USERNAME: 'Administrator' },
  });

  const [linuxCwd, setLinuxCwd] = useState('/home/student');
  const [winCwd, setWinCwd] = useState('C:\\Users\\Student');
  const [linuxHistory, setLinuxHistory] = useState<HistoryItem[]>([]);
  const [winHistory, setWinHistory] = useState<HistoryItem[]>([]);
  const [isDiskpartActive, setIsDiskpartActive] = useState(false);
  const [showFileInspector, setShowFileInspector] = useState(false);

  const isLinux = shell === 'bash';
  const activeFs = isLinux ? linuxFs : winFs;
  const activeState = isLinux ? linuxState : winState;
  const activeCwd = isLinux ? linuxCwd : winCwd;
  const activeHistory = isLinux ? linuxHistory : winHistory;

  const handleExecute = (rawCmd: string) => {
    if (isLinux) {
      const res = executeLinuxLine(rawCmd, linuxCwd, linuxFs, linuxState);
      setLinuxFs(res.newFs);
      setLinuxState(res.newState);
      setLinuxCwd(res.newCwd);
      setLinuxHistory(prev => [
        ...prev,
        {
          id: Math.random().toString(),
          command: rawCmd,
          output: [res.stdout, res.stderr].filter(Boolean).join('\n'),
          errorOutput: res.stderr || undefined,
          isError: res.exitCode !== 0,
          timestamp: new Date().toLocaleTimeString(),
          cwd: res.newCwd,
          shell: 'bash',
        }
      ]);
    } else {
      const res = executeWindowsLine(rawCmd, winCwd, winFs, winState, shell, isDiskpartActive);
      setWinFs(res.newFs);
      setWinState(res.newState);
      setWinCwd(res.newCwd);
      setIsDiskpartActive(!!res.diskpartActive);
      setWinHistory(prev => [
        ...prev,
        {
          id: Math.random().toString(),
          command: rawCmd,
          output: [res.stdout, res.stderr].filter(Boolean).join('\r\n'),
          errorOutput: res.stderr || undefined,
          isError: res.exitCode !== 0,
          timestamp: new Date().toLocaleTimeString(),
          cwd: res.newCwd,
          shell,
        }
      ]);
    }
  };

  const handleResetSandbox = () => {
    if (isLinux) {
      setLinuxFs(createDefaultLinuxFs());
      setLinuxCwd('/home/student');
      setLinuxHistory([]);
    } else {
      setWinFs(createDefaultWindowsFs());
      setWinCwd('C:\\Users\\Student');
      setWinHistory([]);
      setIsDiskpartActive(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-slate-950 overflow-hidden font-sans">
      {/* Top Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3 bg-slate-900/60 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
            <Terminal className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
              <span>Terminal Sandbox Environment</span>
            </h1>
            <div className="text-[11px] text-slate-400 flex items-center gap-2">
              <span>Interactive Virtual Operating Systems</span>
              <span>·</span>
              <span className="font-mono text-cyan-400">{activeState.hostname}</span>
              <span>·</span>
              <span className="font-mono text-slate-300">User: {activeState.currentUser}</span>
            </div>
          </div>
        </div>

        {/* Shell Switcher Controls */}
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs font-medium">
            <button
              onClick={() => setShell('bash')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                shell === 'bash' ? 'bg-amber-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Linux Bash</span>
            </button>
            <button
              onClick={() => setShell('cmd')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                shell === 'cmd' ? 'bg-blue-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>Windows CMD</span>
            </button>
            <button
              onClick={() => setShell('powershell')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                shell === 'powershell' ? 'bg-blue-700 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>PowerShell</span>
            </button>
          </div>

          <button
            onClick={() => setShowFileInspector(!showFileInspector)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${
              showFileInspector
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
            }`}
          >
            <Folder className="w-3.5 h-3.5" />
            <span>Virtual FS</span>
          </button>

          <button
            onClick={handleResetSandbox}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset OS</span>
          </button>
        </div>
      </div>

      {/* Main Terminal Viewport */}
      <div className="flex-1 p-4 overflow-hidden flex gap-4">
        {/* Main Terminal (Expands or Shares with FS Tree) */}
        <div className="flex-1 h-full overflow-hidden">
          <TerminalView
            shell={shell}
            cwd={activeCwd}
            history={activeHistory}
            onExecuteCommand={handleExecute}
            onClearHistory={() => isLinux ? setLinuxHistory([]) : setWinHistory([])}
            isDiskpartActive={isDiskpartActive}
            currentUser={activeState.currentUser}
            hostname={activeState.hostname}
            suggestedCommands={
              isLinux
                ? ['ls -la /etc', 'cat /etc/passwd | grep student', 'chmod 750 /home/student/notes.txt', 'fdisk -l', 'df -h']
                : shell === 'powershell'
                ? ['Get-Service | Where-Object {$_.Status -eq "Stopped"}', 'Get-Process', 'Test-NetConnection 8.8.8.8 -Port 53', 'Get-ADUser']
                : ['ipconfig /all', 'ping 8.8.8.8', 'diskpart', 'tasklist', 'sfc /scannow']
            }
          />
        </div>

        {/* Collapsible Virtual Filesystem Inspector */}
        {showFileInspector && (
          <div className="w-80 h-full bg-slate-900/90 border border-slate-800 rounded-xl p-4 overflow-y-auto space-y-3 text-xs">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 flex items-center gap-1.5">
                <Folder className="w-4 h-4 text-amber-400" />
                <span>Virtual Tree ({isLinux ? 'POSIX root /' : 'NTFS C:\\'})</span>
              </span>
              <span className="text-[10px] text-slate-400 font-mono">Live Inodes</span>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              Files created, edited with redirects (<code className="text-cyan-400">&gt;</code>), or permissions modified via <code className="text-cyan-400">chmod</code> / <code className="text-cyan-400">chown</code> update this tree.
            </p>

            <div className="space-y-1 font-mono text-[11px]">
              {isLinux ? (
                <div>
                  <div className="text-amber-400 font-bold">/</div>
                  <div className="pl-3 border-l border-slate-800 space-y-1 mt-1">
                    <div>📁 bin/ <span className="text-slate-500">(bash, ls, cat)</span></div>
                    <div>📁 etc/ <span className="text-slate-500">(passwd, fstab, hosts)</span></div>
                    <div>📁 home/</div>
                    <div className="pl-3 border-l border-slate-800">
                      <div>📁 student/</div>
                      <div className="pl-3 border-l border-slate-800 text-slate-300">
                        <div>📄 notes.txt <span className="text-cyan-400 font-bold">644</span></div>
                        <div>📁 scripts/</div>
                      </div>
                    </div>
                    <div>📁 var/</div>
                    <div className="pl-3 border-l border-slate-800">
                      <div>📁 log/ <span className="text-slate-500">(syslog, auth.log)</span></div>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-blue-400 font-bold">C:\</div>
                  <div className="pl-3 border-l border-slate-800 space-y-1 mt-1">
                    <div>📁 Windows\</div>
                    <div className="pl-3 border-l border-slate-800">
                      <div>📁 System32\ <span className="text-slate-500">(drivers\etc\hosts)</span></div>
                    </div>
                    <div>📁 Users\</div>
                    <div className="pl-3 border-l border-slate-800">
                      <div>📁 Student\Desktop\ <span className="text-slate-500">(TroubleTicket.txt)</span></div>
                    </div>
                    <div>📁 Logs\ <span className="text-slate-500">(CBS.log)</span></div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
