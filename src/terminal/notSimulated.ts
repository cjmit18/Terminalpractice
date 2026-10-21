// Real commands that lessons mention but the simulator does not implement. Typing one says so,
// instead of "command not found", so learners are not taught that the command does not exist.

export const NOT_SIMULATED_LINUX: readonly string[] = [
  'fsck', 'e2fsck', 'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.vfat', 'mkswap', 'parted', 'gdisk',
  'insmod', 'rmmod', 'modprobe', 'lsof', 'jobs', 'nohup', 'gpg', 'ssh-keygen', 'ssh-copy-id',
];

export const NOT_SIMULATED_WINDOWS: readonly string[] = [
  'winver', 'pathping', 'bcdboot', 'bcdedit', 'schtasks', 'chkdsk',
];

const linuxSet = new Set(NOT_SIMULATED_LINUX);
const windowsSet = new Set(NOT_SIMULATED_WINDOWS.map(n => n.toLowerCase()));

export const isNotSimulatedLinux = (name: string) => linuxSet.has(name);
export const isNotSimulatedWindows = (name: string) => windowsSet.has(name.toLowerCase().replace(/\.exe$/, ''));
