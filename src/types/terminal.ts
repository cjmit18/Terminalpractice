/**
 * Core types for virtual filesystem and terminal execution engines
 */

export type FileType = 'file' | 'directory';

export interface FileNode {
  name: string;
  type: FileType;
  content?: string;
  size?: number;
  permissions: string; // e.g. "rwxr-xr-x"
  octal: number; // e.g. 755
  owner: string; // e.g. "root" or "student"
  group: string; // e.g. "root" or "student"
  updatedAt: string;
  children?: { [key: string]: FileNode };
  /** Device node in /dev (shown as b or c by ls -l). */
  device?: 'block' | 'char';
}

export type TerminalShell = 'bash' | 'cmd' | 'powershell';

export interface HistoryItem {
  id: string;
  command: string;
  output: string;
  errorOutput?: string;
  isError?: boolean;
  /**
   * Learning note from the engine result's `explanation` field: which permission check failed
   * and why. Shown separately from the real terminal output.
   */
  explanation?: string;
  timestamp: string;
  cwd: string;
  shell: TerminalShell;
}

export interface NetworkInterface {
  name: string;
  ip: string;
  netmask: string;
  mac: string;
  gateway: string;
  dns: string[];
  dhcpEnabled: boolean;
  status: 'UP' | 'DOWN';
}

export interface ProcessItem {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
  port?: number;
  isMalicious?: boolean;
}

export interface WindowsService {
  name: string;
  displayName: string;
  status: 'Running' | 'Stopped';
  startType: 'Automatic' | 'Manual' | 'Disabled';
}

export interface VirtualDiskPartition {
  id: number;
  sizeMB: number;
  fsType: 'NTFS' | 'FAT32' | 'ext4' | 'swap' | 'Unallocated';
  driveLetter?: string;
  mountPoint?: string;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  /** Set by `format ... quick`; a full format leaves it unset */
  quickFormatted?: boolean;
}

export interface VirtualDisk {
  diskNumber: number;
  totalSizeMB: number;
  model: string;
  status: 'Online' | 'Offline';
  partitionTable: 'GPT' | 'MBR';
  partitions: VirtualDiskPartition[];
}

export interface ADUser {
  sAMAccountName: string;
  /** Unset on the seeded accounts, which use sAMAccountName@corp.local; '' when New-ADUser was given none */
  userPrincipalName?: string;
  givenName: string;
  surname: string;
  displayName: string;
  email: string;
  department: string;
  ou: string;
  enabled: boolean;
  locked: boolean;
  passwordNeverExpires: boolean;
  memberOf: string[];
}

export interface ADGroup {
  name: string;
  scope: 'Global' | 'Universal' | 'DomainLocal';
  category: 'Security' | 'Distribution';
  ou: string;
  description: string;
  members: string[];
}

export interface GPONode {
  id: string;
  name: string;
  linkedOUs: string[];
  status: 'Enabled' | 'Disabled';
  settings: {
    category: string;
    setting: string;
    value: string;
  }[];
}

export interface SystemState {
  hostname: string;
  currentUser: string;
  currentGroup: string;
  isRootOrAdmin: boolean;
  umask: number; // e.g. 022 or 027
  interfaces: NetworkInterface[];
  processes: ProcessItem[];
  services: WindowsService[];
  disks: VirtualDisk[];
  adUsers: ADUser[];
  adGroups: ADGroup[];
  gpos: GPONode[];
  installedPackages: string[];
  systemIntegrityCorrupted: boolean;
  dismRepaired: boolean;
  sfcRepaired: boolean;
  /** Set by any `sfc /scannow` run, whatever its result (sfcRepaired is set only when the scan could fix everything). */
  sfcScanned?: boolean;
  dnsWorking: boolean;
  gatewayWorking: boolean;
  firewallBlockedPorts: number[];
  diskpartSelectedDisk: number | null;
  diskpartSelectedPartition: number | null;
  envVars: { [key: string]: string };
  /** Set by `ipconfig /flushdns`; `ipconfig /displaydns` then shows only hosts-file entries. */
  dnsCacheFlushed?: boolean;
  /** Windows local accounts created with net user /add (the built-in ones are always present). */
  localUsers?: string[];
  /** Windows local group membership changed with net localgroup; unset means the defaults. */
  localGroups?: { [group: string]: string[] };
  /** Windows lab clock: seconds after 10/19/2026 10:30:15 AM, moved on by commands that take time (gpupdate). */
  windowsClockSeconds?: number;
  /** When gpupdate last applied computer and user policy, on the Windows lab clock; unset means at boot. */
  gpApplied?: { computer?: number; user?: number };
  /** Lines entered in this bash session, oldest first. Maintained by the Linux engine for `history`. */
  commandHistory?: string[];
  /** Exit status of the last bash pipeline, for $?. Maintained by the Linux engine. */
  lastExitCode?: number;
}
