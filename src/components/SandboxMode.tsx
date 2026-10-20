import React, { useState } from 'react';
import { TerminalShell, SystemState } from '../types/terminal';
import { createDefaultLinuxFs, createDefaultWindowsFs } from '../terminal/filesystem';
import { TerminalView } from './TerminalView';
import { FileTree } from './lab/FileTree';
import { createSession, useShellSession } from './lab/useShellSession';
import { PageHeader, ResetButton } from './lab/PageHeader';
import { FolderTree, X } from 'lucide-react';

const LINUX_STATE: SystemState = {
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
};

const WINDOWS_STATE: SystemState = {
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
};

const LINUX_HOME = '/home/student';
const WINDOWS_HOME = 'C:\\Users\\Student';

const SHELLS: TerminalShell[] = ['bash', 'cmd', 'powershell'];

const EXAMPLES: Record<TerminalShell, string[]> = {
  bash: ['ls -la', 'cat /etc/passwd | grep student', 'chmod 750 notes.txt', 'df -h'],
  cmd: ['ipconfig /all', 'tasklist', 'diskpart'],
  powershell: ['Get-Service', 'Get-Process', 'Test-NetConnection 8.8.8.8 -Port 53'],
};

const newLinux = () => createSession(createDefaultLinuxFs(), LINUX_STATE, LINUX_HOME);
const newWindows = () => createSession(createDefaultWindowsFs(), WINDOWS_STATE, WINDOWS_HOME);

export const SandboxMode: React.FC = () => {
  const [shell, setShell] = useState<TerminalShell>('bash');
  const [showFiles, setShowFiles] = useState(false);

  // bash runs on one machine; Command Prompt and PowerShell share the Windows one
  const linux = useShellSession(newLinux);
  const windows = useShellSession(newWindows);

  const isLinux = shell === 'bash';
  const machine = isLinux ? linux : windows;
  const { session } = machine;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-bg text-text">
      <PageHeader
        title="Sandbox"
        meta="A practice machine with no tasks. Nothing here counts toward your progress."
        shellSwitch={{ shells: SHELLS, value: shell, onChange: setShell }}
        actions={
          <>
            <button
              type="button"
              aria-pressed={showFiles}
              onClick={() => setShowFiles(v => !v)}
              className={`inline-flex items-center gap-1.5 h-10 sm:h-9 px-3 rounded-md border text-sm font-medium transition-colors ${
                showFiles ? 'bg-accent-soft text-accent border-accent-soft' : 'bg-surface border-line-strong hover:bg-surface-2'
              }`}
            >
              <FolderTree className="size-4" aria-hidden="true" />
              Files
            </button>
            <ResetButton label="Reset" onClick={() => machine.reset(isLinux ? newLinux() : newWindows())} />
          </>
        }
      />

      <div className="flex-1 min-h-0 flex gap-4 p-3 sm:p-4 overflow-hidden">
        {/* On phones the file tree takes the terminal's place while it is open */}
        <div className={`flex-1 min-w-0 min-h-0 ${showFiles ? 'hidden md:flex' : 'flex'}`}>
          <TerminalView
            shell={shell}
            cwd={session.cwd}
            history={session.history}
            onExecuteCommand={(cmd) => machine.run(cmd, shell)}
            onClearHistory={machine.clearHistory}
            isDiskpartActive={!isLinux && session.diskpartActive}
            currentUser={session.state.currentUser}
            hostname={session.state.hostname}
            suggestedCommands={EXAMPLES[shell]}
          />
        </div>

        {showFiles && (
          <aside
            aria-label="Files"
            className="w-full md:w-[26rem] shrink-0 min-h-0 flex flex-col rounded-md border border-line bg-surface overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 pl-4 pr-1 h-11 border-b border-line shrink-0">
              <h2 className="text-base font-semibold">Files</h2>
              <button
                type="button"
                onClick={() => setShowFiles(false)}
                aria-label="Close files"
                className="inline-flex items-center justify-center size-10 sm:size-8 rounded-sm text-muted hover:text-text hover:bg-surface-2"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <p className="px-4 pt-3 text-sm text-muted">
              {isLinux
                ? 'Updates as you create files, redirect output or change permissions.'
                : 'Updates as you create, copy or delete files.'}
            </p>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
              <FileTree key={isLinux ? 'linux' : 'windows'} root={session.fs} cwd={session.cwd} isWindows={!isLinux} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};
