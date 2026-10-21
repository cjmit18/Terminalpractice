// Real commands that lessons mention but the simulator does not implement. Typing one says so,
// instead of "command not found", so learners are not taught that the command does not exist.

export const NOT_SIMULATED_LINUX: readonly string[] = [
  'fsck', 'e2fsck', 'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.vfat', 'mkswap', 'parted', 'gdisk',
  'insmod', 'rmmod', 'modprobe', 'lsof', 'jobs', 'nohup', 'gpg', 'ssh-keygen', 'ssh-copy-id',
  // Scheduling, sessions and logins
  'crontab', 'at', 'atq', 'atrm', 'batch', 'last', 'lastlog', 'w', 'bg', 'fg', 'top', 'htop', 'watch', 'killall',
  // Files, links, archives and editors
  'ln', 'dd', 'file', 'locate', 'updatedb', 'diff', 'cmp', 'paste', 'join', 'split', 'tac', 'od', 'md5sum', 'sha256sum',
  'gzip', 'gunzip', 'bzip2', 'xz', 'cpio', 'chattr', 'lsattr', 'setfacl', 'getfacl', 'vi', 'vim', 'nano', 'less', 'more',
  // System, boot, packages, storage and networking
  'findmnt', 'umount', 'swapoff', 'hostnamectl', 'localectl', 'visudo', 'shutdown', 'reboot', 'poweroff', 'halt', 'telinit',
  'runlevel', 'grub-install', 'update-grub', 'grub-mkconfig', 'dpkg', 'rpm', 'yum', 'dnf', 'zypper', 'ldd', 'ldconfig',
  'pvcreate', 'vgcreate', 'lvcreate', 'quota', 'edquota', 'logger', 'ssh', 'scp', 'rsync', 'wget', 'curl', 'iptables',
  'ufw', 'nmcli', 'dig', 'host', 'nslookup', 'traceroute', 'tcpdump', 'chroot',
];

export const NOT_SIMULATED_WINDOWS: readonly string[] = [
  'winver', 'pathping', 'bcdboot', 'bcdedit', 'schtasks', 'chkdsk',
];

const linuxSet = new Set(NOT_SIMULATED_LINUX);
const windowsSet = new Set(NOT_SIMULATED_WINDOWS.map(n => n.toLowerCase()));

export const isNotSimulatedLinux = (name: string) => linuxSet.has(name);
export const isNotSimulatedWindows = (name: string) => windowsSet.has(name.toLowerCase().replace(/\.exe$/, ''));
