import React, { useEffect, useRef, useState } from 'react';
import { TerminalShell, SystemState } from '../types/terminal';
import { createDefaultLinuxFs, createDefaultWindowsFs } from '../terminal/filesystem';
import { TerminalView } from './TerminalView';
import { FileTree } from './lab/FileTree';
import { createSession, useShellSession } from './lab/useShellSession';
import { PageHeader, ResetButton } from './lab/PageHeader';
import { FolderTree, X } from 'lucide-react';
import { useGameLayer } from './celebrate/GameLayer';
import { sandboxFacts } from '../lib/activity';
import { BANNER_TEXT, SANDBOX_HOST, SANDBOX_USER, SandboxLook } from './settings/SandboxLook';
import { clearSandboxTry, peekSandboxTry } from './fieldguide/tryInSandbox';

const LINUX_STATE: SystemState = {
  hostname: SANDBOX_HOST,
  currentUser: SANDBOX_USER,
  currentGroup: SANDBOX_USER,
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

const linuxState = (host: string): SystemState => ({ ...LINUX_STATE, hostname: host || LINUX_STATE.hostname });
const windowsState = (host: string): SystemState => {
  const name = host ? host.toUpperCase() : WINDOWS_STATE.hostname;
  return { ...WINDOWS_STATE, hostname: name, envVars: { ...WINDOWS_STATE.envVars, COMPUTERNAME: name } };
};
const newLinux = (host = '') => createSession(createDefaultLinuxFs(), linuxState(host), LINUX_HOME);
const newWindows = (host = '') => createSession(createDefaultWindowsFs(), windowsState(host), WINDOWS_HOME);

export const SandboxMode: React.FC = () => {
  // A command offered by "Try it in the Sandbox" (the field guide, the Reference page)
  const [offered] = useState(peekSandboxTry);
  useEffect(() => clearSandboxTry(), []);
  const [shell, setShell] = useState<TerminalShell>(offered?.shell ?? 'bash');
  const [panel, setPanel] = useState<'files' | 'look' | null>(null);
  const showFiles = panel === 'files';
  // Counts resets, so the terminal shows the login banner of the fresh machine
  const [resetCount, setResetCount] = useState(0);

  // bash runs on one machine; Command Prompt and PowerShell share the Windows one
  // Commands here are tagged as done in the Sandbox (for "Free play"), and three in a day count
  // toward the weekly goal
  const { record, sandboxCommand, prefs, unlocks } = useGameLayer();
  const host = unlocks.hostname ? prefs.sandboxHost : '';
  const promptStyle = unlocks.prompt ? prefs.promptStyle : 'standard';
  const bannerLine = unlocks.banner ? BANNER_TEXT[prefs.bannerLine] : '';
  const recordSandbox = (facts: string[]) => {
    record(sandboxFacts(facts));
    sandboxCommand();
  };
  const linux = useShellSession(() => newLinux(host), undefined, recordSandbox);
  const windows = useShellSession(() => newWindows(host), undefined, recordSandbox);

  // A new machine name applies to the running machines too, without a reset
  const appliedHost = useRef(host);
  useEffect(() => {
    if (appliedHost.current === host) return;
    appliedHost.current = host;
    const l = linuxState(host);
    const w = windowsState(host);
    linux.setSystemState({ ...linux.session.state, hostname: l.hostname });
    windows.setSystemState({
      ...windows.session.state,
      hostname: w.hostname,
      envVars: { ...windows.session.state.envVars, COMPUTERNAME: w.hostname },
    });
  }, [host, linux, windows]);

  const isLinux = shell === 'bash';
  const machine = isLinux ? linux : windows;
  const { session } = machine;
  const examples =
    offered && offered.shell === shell ? [offered.command, ...EXAMPLES[shell].filter(e => e !== offered.command)] : EXAMPLES[shell];
  const anyUnlock = unlocks.hostname || unlocks.prompt || unlocks.banner;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-bg text-text">
      <PageHeader
        title="Sandbox"
        meta="A practice machine with no tasks. Nothing here counts toward your progress."
        shellSwitch={{ shells: SHELLS, value: shell, onChange: setShell }}
        actions={
          <>
            <a
              href="#/sandbox/challenge"
              className="inline-flex items-center h-10 sm:h-9 px-2 rounded-md text-sm font-medium text-accent hover:bg-surface-2"
            >
              Challenges
            </a>
            {anyUnlock && (
              <button
                type="button"
                aria-pressed={panel === 'look'}
                onClick={() => setPanel(v => (v === 'look' ? null : 'look'))}
                className={`inline-flex items-center h-10 sm:h-9 px-3 rounded-md border text-sm font-medium transition-colors ${
                  panel === 'look' ? 'bg-accent-soft text-accent border-accent-soft' : 'bg-surface border-line-strong hover:bg-surface-2'
                }`}
              >
                Your machine
              </button>
            )}
            <button
              type="button"
              aria-pressed={showFiles}
              onClick={() => setPanel(v => (v === 'files' ? null : 'files'))}
              className={`inline-flex items-center gap-1.5 h-10 sm:h-9 px-3 rounded-md border text-sm font-medium transition-colors ${
                showFiles ? 'bg-accent-soft text-accent border-accent-soft' : 'bg-surface border-line-strong hover:bg-surface-2'
              }`}
            >
              <FolderTree className="size-4" aria-hidden="true" />
              Files
            </button>
            <ResetButton label="Reset" onClick={() => {
                machine.reset(isLinux ? newLinux(host) : newWindows(host));
                setResetCount(n => n + 1);
              }}
            />
          </>
        }
      />

      <div className="flex-1 min-h-0 flex gap-4 p-3 sm:p-4 overflow-hidden">
        {/* On phones the file tree takes the terminal's place while it is open */}
        <div className={`flex-1 min-w-0 min-h-0 ${panel ? 'hidden md:flex' : 'flex'}`}>
          <TerminalView
            shell={shell}
            cwd={session.cwd}
            history={session.history}
            onExecuteCommand={(cmd) => machine.run(cmd, shell)}
            onClearHistory={machine.clearHistory}
            onActivity={record}
            resetKey={resetCount}
            isDiskpartActive={!isLinux && session.diskpartActive}
            currentUser={session.state.currentUser}
            hostname={session.state.hostname}
            suggestedCommands={examples}
            promptStyle={promptStyle}
            bannerLine={bannerLine || undefined}
            fs={session.fs}
          />
        </div>

        {panel === 'look' && (
          <aside
            aria-label="Your machine"
            className="w-full md:w-[26rem] shrink-0 min-h-0 flex flex-col rounded-md border border-line bg-surface overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 pl-4 pr-1 h-11 border-b border-line shrink-0">
              <h2 className="text-base font-semibold">Your machine</h2>
              <button
                type="button"
                onClick={() => setPanel(null)}
                aria-label="Close your machine settings"
                className="inline-flex items-center justify-center size-10 sm:size-8 rounded-sm text-muted hover:text-text hover:bg-surface-2"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
              <SandboxLook defaultHost={LINUX_STATE.hostname} user={linux.session.state.currentUser} host={linux.session.state.hostname} />
            </div>
          </aside>
        )}

        {showFiles && (
          <aside
            aria-label="Files"
            className="w-full md:w-[26rem] shrink-0 min-h-0 flex flex-col rounded-md border border-line bg-surface overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 pl-4 pr-1 h-11 border-b border-line shrink-0">
              <h2 className="text-base font-semibold">Files</h2>
              <button
                type="button"
                onClick={() => setPanel(null)}
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
