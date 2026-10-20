# Terminus CertSim - LPI Linux & CompTIA Windows PBQ Simulator

A high-fidelity, interactive terminal simulation and performance-based question (PBQ) platform designed for IT certification candidates studying for:
- **LPI Linux Essentials & LPIC-1 (Exams 101-500, 102-500)**
- **CompTIA A+ (Core 2 220-1102)**
- **CompTIA Network+ (N10-008 / N10-009)**
- **CompTIA Security+ (SY0-701)**

---

## Features

- **POSIX Virtual Filesystem**: Real node hierarchy with full permission enforcement (`r`, `w`, `x`, `s`, `t`), SUID (4000), SGID (2000), and Sticky Bit (1000) support.
- **Dual Engine Architecture**:
  - **Linux Engine (Bash)**: Implements standard coreutils (`ls`, `cat`, `grep`, `head`, `tail`, `wc`, `awk`, `sed`, `chmod`, `chown`, `umask`, `mkdir -p`, `rm -rf`, `tee`, `systemctl`, `journalctl`, `ip`, `ps`, `kill`, `su`, `sudo`).
  - **Windows Engine (CMD & PowerShell)**: Interactive `diskpart` partition & formatting shell, `net user / add`, `gpresult /r`, `ipconfig`, `route`, `ping`, `tracert`, `sfc /scannow`, `dism /restorehealth`, `Test-NetConnection`, and `Get-Service`.
- **Quote-Aware Shell Parser**:
  - Handles shell quote preservation (`"echo a > b"` does not redirect, `'x && y'` does not split).
  - Handles command chaining: `&&`, `||`, and `;` in Bash; `&&`, `||`, and `&` in CMD.
  - Multi-stage pipelines with stdin filtering (`grep`, `awk`, `sed`, `wc`, `findstr`, `more`).
  - Stderr redirection support: `2>`, `2>>`, `2>&1`, and `2>/dev/null`.
- **Permission Matrix Visualizer**:
  - Live interactive chmod converter mapping 4-digit octal codes, symbolic strings, and binary representations.
  - SUID / SGID / Sticky bit presets (`4755`, `2755`, `1777`, `0750`, `0644`).
- **Interactive Exam Lab Objectives**:
  - Step-by-step verification engines that check real filesystem and system state rather than naive regex string matching.

---

## Architecture

```
src/
├── terminal/
│   ├── parser.ts         # Quote-aware tokenizer, pipeline splitter, chaining parser & stderr extractor
│   ├── filesystem.ts     # In-memory virtual POSIX & Windows filesystem, permission validator, applyChmod
│   ├── linuxEngine.ts    # Bash command execution, pipeline runner, sudo/su state transitions
│   ├── windowsEngine.ts  # CMD & PowerShell executor, interactive diskpart subshell, piping to findstr
│   └── rules.test.ts     # Automated regression & unit test suite (18 test suites)
├── components/
│   ├── Terminal.tsx      # ANSI-compliant terminal emulator component with tab completion & history
│   ├── PermissionMatrixSim.tsx # Interactive permission bit matrix explorer
│   ├── LpiLabView.tsx    # LPI certification practice modules
│   └── WindowsPbqView.tsx# CompTIA Windows PBQ scenarios
└── data/
    ├── lpiModules.ts     # LPI exam labs and state verifiers
    └── windowsPbqs.ts    # CompTIA PBQ troubleshooting scenarios
```

---

## Running Locally

### Prerequisites
- Node.js 18+
- npm 9+

### Quick Start
```bash
# Install dependencies
npm ci

# Run test suite
npm test

# Start development server
npm run dev

# Build production bundle
npm run build
```

---

## Test Suite

The automated test suite runs via Node.js native test runner and `tsx`:
```bash
npm test
```
Validates:
1. Bidirectional octal and symbolic permission conversions
2. POSIX path normalization and tilde home directory expansion
3. Quote-aware tokenization and escape character handling
4. Pipeline command splitting
5. Linux core commands and pipeline flows
6. Windows CMD commands and interactive DiskPart subshells
7. LPI and CompTIA module verifiers
8. POSIX permission enforcement, user groups, and sudo elevation
9. Chaining operators (`&&`, `||`, `;`), quote safety, and grep pipes
10. SUID / SGID / Sticky bits preservation in chmod
11. Symbolic chmod clauses (`[ugoa]*[+-=][rwxst]*`)
12. Sudo redirection trap vs `tee` elevation
13. Stderr redirection (`2>`, `2>>`, `2>&1`, `2>/dev/null`)
14. `mkdir -p` recursive creation and existing directory checks
15. Chained command error accumulation
16. CMD `&` sequencing and CMD pipeline filtering with `findstr`
17. `rm` directory safety checks and `rm -f` flags
18. Supplementary group resolution from `/etc/group`
19. Windows redirect default mode (644)
