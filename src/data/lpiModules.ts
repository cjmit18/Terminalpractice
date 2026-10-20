import { ExamModule } from '../types/modules';
import { SystemState } from '../types/terminal';
import { createDefaultLinuxFs, getNodeAtPath } from '../terminal/filesystem';

const baseLinuxState: SystemState = {
  hostname: 'lpi-lab01',
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
    },
    {
      name: 'lo',
      ip: '127.0.0.1',
      netmask: '255.0.0.0',
      mac: '00:00:00:00:00:00',
      gateway: '',
      dns: [],
      dhcpEnabled: false,
      status: 'UP' as const,
    }
  ],
  processes: [
    { pid: 1, user: 'root', cpu: 0.0, mem: 0.4, command: '/sbin/init splash' },
    { pid: 610, user: 'root', cpu: 0.1, mem: 0.8, command: '/lib/systemd/systemd-journald' },
    { pid: 820, user: 'root', cpu: 0.0, mem: 0.3, command: '/usr/sbin/cron -f' },
    { pid: 1420, user: 'root', cpu: 0.0, mem: 1.2, command: '/usr/sbin/sshd -D', port: 22 },
    { pid: 2100, user: 'student', cpu: 0.1, mem: 0.9, command: 'bash' },
  ],
  services: [
    { name: 'ssh', displayName: 'OpenBSD Secure Shell server', status: 'Running', startType: 'Automatic' },
    { name: 'cron', displayName: 'Regular background program processing daemon', status: 'Running', startType: 'Automatic' },
    { name: 'nginx', displayName: 'Nginx HTTP and reverse proxy server', status: 'Running', startType: 'Manual' },
  ],
  disks: [
    {
      diskNumber: 0,
      totalSizeMB: 51200,
      model: 'QEMU VIRTUAL DISK',
      status: 'Online',
      partitionTable: 'GPT',
      partitions: [
        { id: 1, sizeMB: 512, fsType: 'ext4', mountPoint: '/boot', isPrimary: true, isActive: true },
        { id: 2, sizeMB: 4096, fsType: 'swap', isPrimary: true },
        { id: 3, sizeMB: 46592, fsType: 'ext4', mountPoint: '/', isPrimary: true },
      ],
    }
  ],
  adUsers: [],
  adGroups: [],
  gpos: [],
  installedPackages: ['bash', 'coreutils', 'systemd', 'grep', 'tar', 'iproute2', 'cron'],
  systemIntegrityCorrupted: false,
  dismRepaired: false,
  sfcRepaired: false,
  dnsWorking: true,
  gatewayWorking: true,
  firewallBlockedPorts: [],
  diskpartSelectedDisk: null,
  diskpartSelectedPartition: null,
  envVars: {
    USER: 'student',
    HOME: '/home/student',
    SHELL: '/bin/bash',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  },
};

export const LPI_MODULES: ExamModule[] = [
  {
    id: 'lpi-104-5-permissions',
    track: 'lpi',
    examCode: 'LPIC-1 Exam 101-500',
    topicNumber: 'Topic 104.5',
    title: 'Manage File Permissions and Ownership',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    scenarioDescription: 'Security Audit Warning: The finance department directory /home/student/finance has insecure permissions (currently 777), exposing quarterly payroll data to all local accounts. As the Linux Systems Administrator, you must configure strict permissions so only user "root" has full Read/Write/Execute access, group "finance" has Read & Execute access, and Others have zero access. Then, change the file ownership to user "root" and group "finance". Finally, adjust the default umask to 027.',
    systemContext: 'Host: lpi-lab01 | Current User: student (with sudo access) | Path: /home/student',
    defaultShell: 'bash',
    allowedShells: ['bash'],
    simType: 'permission-matrix',
    objectives: [
      {
        id: 'perm-check',
        title: 'Audit Insecure Directory',
        description: 'Inspect the permissions of /home/student/finance using ls -ld.',
        hint: 'Run "ls -ld /home/student/finance" or "ls -la /home/student" to see current permissions.',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && (ctx.command.includes('ls -l') || ctx.command.includes('ls -ld') || ctx.command.includes('ls -la')) && ctx.stdout.includes('finance'),
      },
      {
        id: 'perm-chmod',
        title: 'Apply Strict Permissions (750)',
        description: 'Set permissions of /home/student/finance so owner=rwx, group=r-x, others=--- (numeric 750).',
        hint: 'Execute: chmod 750 /home/student/finance',
        verifier: (fs) => {
          const node = getNodeAtPath(fs, '/home/student/finance', false);
          return !!node && (node.octal === 750 || node.permissions === 'rwxr-x---');
        },
      },
      {
        id: 'perm-chown',
        title: 'Set Owner and Group to root:finance',
        description: 'Change the ownership of /home/student/finance to owner root and group finance.',
        hint: 'Execute: sudo chown root:finance /home/student/finance',
        verifier: (fs) => {
          const node = getNodeAtPath(fs, '/home/student/finance', false);
          return !!node && node.owner === 'root' && node.group === 'finance';
        },
      },
      {
        id: 'perm-umask',
        title: 'Configure Umask to 027',
        description: 'Set the active process umask to 027 (yielding 750 for new directories and 640 for new files).',
        hint: 'Run "umask 027" or "umask 0027" in your terminal.',
        verifier: (_, state) => state.umask === 0o027,
      },
    ],
    initialFs: (() => {
      const fs = createDefaultLinuxFs();
      const studentDir = getNodeAtPath(fs, '/home/student', false);
      if (studentDir && studentDir.children) {
        studentDir.children['finance'] = {
          name: 'finance',
          type: 'directory',
          permissions: 'rwxrwxrwx',
          octal: 777,
          owner: 'student',
          group: 'student',
          updatedAt: '2026-10-19T00:00:00Z',
          children: {
            'q3_payroll.csv': {
              name: 'q3_payroll.csv',
              type: 'file',
              permissions: 'rw-rw-rw-',
              octal: 666,
              owner: 'student',
              group: 'student',
              updatedAt: '2026-10-19T00:00:00Z',
              content: 'EmployeeID,Name,Salary\n101,Alice,85000\n102,Bob,92000\n103,Charlie,78000',
            }
          }
        };
      }
      return fs;
    })(),
    initialState: { ...baseLinuxState },
    solutionWalkthrough: [
      {
        step: 1,
        title: 'Inspect Current Inode Mode Bits',
        command: 'ls -ld /home/student/finance',
        explanation: 'The initial output "drwxrwxrwx" indicates world-writable permissions (777), which violates the principle of least privilege.',
        underlyingConcept: 'Linux file permissions are evaluated from left to right: Owner bits (User), Group bits, and Others bits. Each triplet contains Read (4), Write (2), and Execute (1).',
      },
      {
        step: 2,
        title: 'Change File Mode to 750',
        command: 'chmod 750 /home/student/finance',
        explanation: '7 = rwx (4+2+1), 5 = r-x (4+0+1), 0 = --- (0+0+0). This restricts directory traversal and file listing to the owner and group.',
        underlyingConcept: 'On Linux directories, the Execute bit (x) does not mean running a binary; it grants permission to enter (traverse) into the directory and access child inodes.',
      },
      {
        step: 3,
        title: 'Transfer Inode Ownership to root:finance',
        command: 'sudo chown root:finance /home/student/finance',
        explanation: 'The colon ":" syntax sets both user and group in a single atomic command.',
        underlyingConcept: 'Only the superuser (root) can change file ownership in POSIX systems to prevent quota manipulation and privilege bypass attacks.',
      },
      {
        step: 4,
        title: 'Restrict Creation Mask (Umask)',
        command: 'umask 027',
        explanation: 'Subtracting 027 from default directory creation mode 777 yields 750 (rwxr-x---), and from file mode 666 yields 640 (rw-r-----).',
        underlyingConcept: 'Umask acts as a bitwise filter (AND NOT mask). Bits set in the umask are stripped away from initial file creation permissions.',
      },
    ],
    examTips: [
      'LPI Exam Trap: Remember that "chmod 750" produces "rwxr-x---", whereas "chmod 755" produces "rwxr-xr-x".',
      'Special permissions: SUID (4000) runs binary as file owner, SGID (2000) inherits group or executes with group rights, Sticky Bit (1000) prevents deleting others files in shared dirs like /tmp.',
    ],
  },
  {
    id: 'lpi-103-2-text-processing',
    track: 'lpi',
    examCode: 'LPIC-1 Exam 101-500',
    topicNumber: 'Topic 103.2',
    title: 'Process Text Streams Using Filters & Pipes',
    difficulty: 'Intermediate',
    estimatedMinutes: 20,
    scenarioDescription: 'Security Incident Investigation: The corporate server was subject to a brute-force SSH password attack earlier this morning. The security analyst requires an extracted list of all failed login attempts from /var/log/auth.log. Filter the log for lines containing "Failed password", isolate the attacking IP addresses, sort them, and count the distinct occurrences using pipeline tools.',
    systemContext: 'Host: lpi-lab01 | Log Target: /var/log/auth.log | Task: Filter & Aggregate Pipeline',
    defaultShell: 'bash',
    allowedShells: ['bash'],
    simType: 'terminal-only',
    objectives: [
      {
        id: 'obj-grep',
        title: 'Filter Failed SSH Passwords',
        description: 'Use grep to search for "Failed password" in /var/log/auth.log.',
        hint: 'Execute: grep "Failed password" /var/log/auth.log',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && /grep/.test(ctx.command) && ctx.stdout.includes('198.51.100.44'),
      },
      {
        id: 'obj-pipe-awk',
        title: 'Extract IP Addresses via Pipeline',
        description: 'Pipe the grep output into awk to extract the IP address field.',
        hint: 'Execute: grep "Failed password" /var/log/auth.log | awk \'{print $(NF-3)}\'',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && ctx.command.includes('|') && (/awk/.test(ctx.command) || /cut/.test(ctx.command)) && ctx.stdout.includes('198.51.100.44'),
      },
      {
        id: 'obj-sort-uniq',
        title: 'Count Unique Offending IPs',
        description: 'Pipe the IPs through sort and uniq -c to tally the attack attempts per IP.',
        hint: 'Execute: grep "Failed password" /var/log/auth.log | awk \'{print $(NF-3)}\' | sort | uniq -c',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && ctx.command.includes('sort') && ctx.command.includes('uniq') && ctx.stdout.includes('198.51.100.44'),
      },
    ],
    initialFs: createDefaultLinuxFs(),
    initialState: { ...baseLinuxState },
    solutionWalkthrough: [
      {
        step: 1,
        title: 'Filter Log Stream with Grep',
        command: 'grep "Failed password" /var/log/auth.log',
        explanation: 'Grep searches for the literal string pattern across all lines of the target authentication log.',
        underlyingConcept: 'Grep operates line-by-line using regular expressions or fixed strings, directing matching lines to STDOUT.',
      },
      {
        step: 2,
        title: 'Isolate Delimited Columns with AWK',
        command: 'grep "Failed password" /var/log/auth.log | awk \'{print $(NF-3)}\'',
        explanation: 'Using $(NF-3) indexes 3 fields from the end of the line (NF=ssh2, NF-1=port, NF-2=port number, NF-3=IP), which reliably isolates the IP regardless of variable username lengths.',
        underlyingConcept: 'AWK splits lines on whitespace by default into positional variables ($1, $2, ... $NF). Pipe (|) connects STDOUT of grep to STDIN of awk.',
      },
      {
        step: 3,
        title: 'Aggregate Frequencies with Sort and Uniq',
        command: 'grep "Failed password" /var/log/auth.log | awk \'{print $(NF-3)}\' | sort | uniq -c',
        explanation: 'Uniq only collapses adjacent duplicate lines; therefore, data must ALWAYS be sorted prior to piping into uniq.',
        underlyingConcept: 'The -c flag of uniq prefixes each line with its frequency count, providing instant frequency metrics without a database.',
      },
    ],
    examTips: [
      'Golden LPI Rule: ALWAYS put sort BEFORE uniq! If input is not sorted, uniq will fail to count duplicate occurrences across non-adjacent lines.',
      'Field positions shift when log lines vary (e.g. invalid user vs root), which is why $NF and $(NF-n) exist to index backwards from the end of the line.',
      'Remember: "cut -d: -f1 /etc/passwd" is the classic exam question for extracting usernames from passwd.',
    ],
  },
  {
    id: 'lpi-101-1-system-architecture',
    track: 'lpi',
    examCode: 'LPIC-1 Exam 101-500',
    topicNumber: 'Topic 101.1',
    title: 'Determine and Configure Hardware Settings',
    difficulty: 'Beginner',
    estimatedMinutes: 10,
    scenarioDescription: 'Hardware Audit Task: A new virtual server has been deployed in the datacenter. You need to verify the hardware bus devices, inspect the loaded kernel modules (specifically networking driver e1000e), and check the kernel boot ring buffer for SATA AHCI controller initialization messages.',
    systemContext: 'Host: lpi-lab01 | Objective: Hardware Inspection & Kernel Modules',
    defaultShell: 'bash',
    allowedShells: ['bash'],
    simType: 'terminal-only',
    objectives: [
      {
        id: 'hw-lspci',
        title: 'Query Peripheral Component Interconnect (PCI) Devices',
        description: 'Run lspci to inspect connected Ethernet and VGA controllers.',
        hint: 'Type "lspci" and press Enter.',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && ctx.command.trim().startsWith('lspci') && ctx.stdout.includes('Ethernet'),
      },
      {
        id: 'hw-lsmod',
        title: 'Inspect Loaded Kernel Modules',
        description: 'Run lsmod or query loaded modules to check driver status.',
        hint: 'Type "lsmod" or "lsmod | grep e1000e".',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && ctx.command.includes('lsmod') && (ctx.stdout.includes('e1000e') || ctx.stdout.includes('Module')),
      },
      {
        id: 'hw-dmesg',
        title: 'Inspect Kernel Ring Buffer',
        description: 'Examine boot hardware logs using dmesg.',
        hint: 'Type "dmesg" or "dmesg | grep SATA".',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && ctx.command.includes('dmesg') && (ctx.stdout.includes('SATA') || ctx.stdout.includes('e1000e') || ctx.stdout.includes('Linux')),
      },
    ],
    initialFs: createDefaultLinuxFs(),
    initialState: { ...baseLinuxState },
    solutionWalkthrough: [
      {
        step: 1,
        title: 'List PCI Bus Devices',
        command: 'lspci',
        explanation: 'lspci inspects the /sys/bus/pci virtual filesystem tree to display vendor IDs and device classes for all connected buses.',
        underlyingConcept: 'PCI and PCIe are standard motherboard interconnects. lspci retrieves hardware database entries mapped by vendor and device IDs.',
      },
      {
        step: 2,
        title: 'Query Linux Kernel Module Status',
        command: 'lsmod',
        explanation: 'Displays dynamically loaded Loadable Kernel Modules (LKMs), their memory footprints, and module dependency usage counts.',
        underlyingConcept: 'Kernel modules allow Linux to extend device driver support without recompiling the monolithic kernel. lsmod reads directly from /proc/modules.',
      },
      {
        step: 3,
        title: 'Analyze Kernel Ring Buffer Boot Messages',
        command: 'dmesg | grep -i sata',
        explanation: 'dmesg outputs kernel-level diagnostic and driver initialization logs from the circular ring buffer memory.',
        underlyingConcept: 'During boot, before user-space syslog daemons start, the Linux kernel stores all early hardware detection events in the ring buffer.',
      },
    ],
    examTips: [
      'LPIC-1 Objective 101.1 commands: lspci (PCI bus), lsusb (USB devices), lsmod (loaded modules), modprobe (load/unload with dependencies), insmod/rmmod (manual insertion/removal), /proc/cpuinfo, /proc/meminfo.',
    ],
  },
  {
    id: 'lpi-107-1-user-administration',
    track: 'lpi',
    examCode: 'LPIC-1 Exam 102-500',
    topicNumber: 'Topic 107.1',
    title: 'Manage User and Group Accounts',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    scenarioDescription: 'Onboarding System Task: A new developer named "sarah" has joined the engineering team. Create a new user account with home directory /home/sarah, set her login shell to /bin/bash, assign her to the secondary group "developers", and verify her configuration in /etc/passwd.',
    systemContext: 'Host: lpi-lab01 | Role: Sysadmin | Security: Least Privilege User Creation',
    defaultShell: 'bash',
    allowedShells: ['bash'],
    simType: 'terminal-only',
    objectives: [
      {
        id: 'usr-create',
        title: 'Create Account with Home Directory & Secondary Group',
        description: 'Use useradd with -m (create home) and -G developers for user "sarah".',
        hint: 'Execute: sudo useradd -m -G developers sarah',
        verifier: (fs) => {
          const passwd = getNodeAtPath(fs, '/etc/passwd', false);
          return !!passwd && !!passwd.content && passwd.content.includes('sarah');
        },
      },
      {
        id: 'usr-verify-home',
        title: 'Verify User Home Directory Exists',
        description: 'Confirm that /home/sarah directory was created.',
        hint: 'Run "ls -ld /home/sarah".',
        verifier: (fs) => {
          const home = getNodeAtPath(fs, '/home/sarah', false);
          return !!home && home.type === 'directory';
        },
      },
      {
        id: 'usr-verify-passwd',
        title: 'Inspect /etc/passwd Entry',
        description: 'Use grep or cat to inspect the /etc/passwd record for sarah.',
        hint: 'Execute: grep sarah /etc/passwd',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && ctx.command.includes('sarah') && (/grep/.test(ctx.command) || /cat/.test(ctx.command)) && ctx.stdout.includes('sarah'),
      },
    ],
    initialFs: createDefaultLinuxFs(),
    initialState: { ...baseLinuxState },
    solutionWalkthrough: [
      {
        step: 1,
        title: 'Execute User Creation with Command Flags',
        command: 'sudo useradd -m -s /bin/bash -G developers sarah',
        explanation: '-m flags automatic home directory creation from /etc/skel; -s defines the login shell; -G specifies secondary supplementary groups.',
        underlyingConcept: 'In Linux, -g designates primary GID, whereas capital -G appends secondary group memberships.',
      },
      {
        step: 2,
        title: 'Verify Inode Creation',
        command: 'ls -ld /home/sarah',
        explanation: 'Verifies the user home directory exists with appropriate owner and permissions.',
        underlyingConcept: 'Files copied into the new user home originate from the template directory /etc/skel (e.g. .bashrc, .profile).',
      },
      {
        step: 3,
        title: 'Verify Record in Password Database',
        command: 'grep sarah /etc/passwd',
        explanation: 'Verifies the 7-field /etc/passwd colon-delimited structure: username:password:UID:GID:GECOS:home:shell.',
        underlyingConcept: 'The password field is set to "x" because password hashes are stored in the shadow password file /etc/shadow, protected by root-only read permissions (640 or 400).',
      },
    ],
    examTips: [
      'Key Exam Distinction: "useradd" is the low-level standard binary across all Linux distros. "adduser" is an interactive Perl script wrapper found primarily on Debian/Ubuntu.',
      'Remember: "usermod -aG group user" appends a group; omitting -a will overwrite and remove all other secondary groups!',
    ],
  },
  {
    id: 'lpi-102-1-disk-partitioning',
    track: 'lpi',
    examCode: 'LPIC-1 Exam 101-500',
    topicNumber: 'Topic 102.1',
    title: 'Design Hard Disk Layout & Partitioning',
    difficulty: 'Intermediate',
    estimatedMinutes: 15,
    scenarioDescription: 'Storage Architecture Analysis: Inspect the system storage configuration. Query the GPT partition tables using fdisk -l to identify EFI, Swap, and Root partitions. Then, verify mounted filesystem capacities and mount points using df -h.',
    systemContext: 'Host: lpi-lab01 | Task: Partition Table & Storage Allocation',
    defaultShell: 'bash',
    allowedShells: ['bash'],
    simType: 'diskpart',
    objectives: [
      {
        id: 'disk-fdisk',
        title: 'List Partition Table with fdisk',
        description: 'Run "fdisk -l" to examine disk partitions, sectors, and GUID partition table structure.',
        hint: 'Execute: sudo fdisk -l',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && ctx.command.includes('fdisk') && ctx.command.includes('-l') && ctx.stdout.includes('Disk /dev/sda'),
      },
      {
        id: 'disk-df',
        title: 'Check Filesystem Free Space',
        description: 'Run "df -h" to check human-readable disk consumption.',
        hint: 'Execute: df -h',
        verifier: (_, __, ctx) => !!ctx && ctx.exitCode === 0 && ctx.command.trim().startsWith('df') && ctx.stdout.includes('/boot'),
      },
    ],
    initialFs: createDefaultLinuxFs(),
    initialState: { ...baseLinuxState },
    solutionWalkthrough: [
      {
        step: 1,
        title: 'Inspect Partition Tables',
        command: 'sudo fdisk -l',
        explanation: 'fdisk lists partition table format (GPT vs MBR), sector size (512 bytes), and partition boundaries.',
        underlyingConcept: 'GPT (GUID Partition Table) overcomes MBR 2TB disk limits, supports up to 128 primary partitions by default, and includes CRC32 header redundancy.',
      },
      {
        step: 2,
        title: 'Query Active Mount Points and Free Blocks',
        command: 'df -h',
        explanation: 'df reads the superblock of mounted filesystems to display size, used, available, and percentage usage in human-readable units (G/M).',
        underlyingConcept: 'LPI distinguishes "df" (disk free space of filesystems) from "du" (disk usage of specific files and directory trees).',
      },
    ],
    examTips: [
      'LPI Exam Knowledge: MBR is limited to 4 primary partitions (or 3 primary + 1 extended containing logical partitions) and 2.2TB disk size. GPT supports disks up to 9.4 ZB with UEFI boot.',
    ],
  },
];
