// The Windows machine the Sandbox starts on. Kept apart from the Sandbox page so tests can run the real seed.
import type { SystemState } from '../types/terminal';

export const SANDBOX_WINDOWS_STATE: SystemState = {
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
      rid: 500,
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
      rid: 512,
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
