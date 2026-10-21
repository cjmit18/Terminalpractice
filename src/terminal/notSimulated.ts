// Real commands that lessons mention but the simulator does not implement. Typing one says so,
// instead of "command not found", so learners are not taught that the command does not exist.

export const NOT_SIMULATED_LINUX: readonly string[] = [
  'fsck', 'e2fsck', 'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.vfat', 'mkswap', 'parted', 'gdisk',
  'insmod', 'rmmod', 'modprobe', 'lsof', 'jobs', 'nohup', 'gpg', 'ssh-keygen', 'ssh-copy-id',
];

export const NOT_SIMULATED_WINDOWS: readonly string[] = [
  'winver', 'pathping', 'bcdboot', 'bcdedit', 'schtasks', 'chkdsk',
  // CMD and system tools the lessons mention
  'robocopy', 'xcopy', 'sc', 'rd', 'rmdir', 'move', 'ren', 'rename', 'attrib', 'icacls', 'cacls', 'takeown', 'netsh', 'shutdown',
  'format', 'find', 'sort', 'tree', 'fc', 'where', 'arp', 'getmac', 'nbtstat', 'nltest', 'w32tm', 'powercfg', 'cipher',
  'manage-bde', 'wmic', 'mstsc', 'certutil', 'msconfig', 'regedit', 'eventvwr', 'gpedit.msc', 'mmc', 'diskmgmt.msc',
  'services.msc', 'msinfo32', 'perfmon', 'resmon', 'taskmgr', 'control', 'driverquery', 'reg', 'runas', 'cscript', 'wscript',
  // PowerShell cmdlets the lessons mention
  'Read-Host', 'ConvertTo-SecureString', 'Get-EventLog', 'Get-WinEvent', 'Restart-Computer', 'Stop-Computer',
  'Get-ADGroup', 'New-ADGroup', 'Set-ADUser', 'Remove-ADUser', 'Remove-ADGroupMember', 'Get-ADComputer', 'Get-NetAdapter',
  'Get-NetIPAddress', 'Get-DnsClientCache', 'Resolve-DnsName', 'Get-Disk', 'Get-Volume', 'Get-Partition', 'Get-SmbShare',
  'Get-LocalUser', 'New-LocalUser', 'Get-LocalGroupMember', 'Add-LocalGroupMember', 'Get-ExecutionPolicy', 'Set-ExecutionPolicy',
  'Get-HotFix', 'Get-ComputerInfo', 'Get-CimInstance', 'Get-WmiObject', 'Get-GPO', 'Get-GPResultantSetOfPolicy', 'Start-Process',
];

const linuxSet = new Set(NOT_SIMULATED_LINUX);
const windowsSet = new Set(NOT_SIMULATED_WINDOWS.map(n => n.toLowerCase()));

export const isNotSimulatedLinux = (name: string) => linuxSet.has(name);
export const isNotSimulatedWindows = (name: string) => windowsSet.has(name.toLowerCase().replace(/\.exe$/, ''));
