/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Header, AppTab } from './components/Header';
import { ModuleSelector } from './components/ModuleSelector';
import { ModuleRunner } from './components/ModuleRunner';
import { SimulatorsHub } from './components/SimulatorsHub';
import { SandboxMode } from './components/SandboxMode';
import { CommandEncyclopedia } from './components/CommandEncyclopedia';
import { LPI_MODULES } from './data/lpiModules';
import { WINDOWS_PBQS } from './data/windowsPbqs';
import { ExamModule } from './types/modules';
import { SystemState } from './types/terminal';
import { ArrowLeft } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('lpi');
  const [selectedModule, setSelectedModule] = useState<ExamModule | null>(LPI_MODULES[0]);
  // moduleId -> completed objective ids
  const [progress, setProgress] = useState<Record<string, string[]>>({});

  // Shared state for the simulators hub
  const [sharedSimState, setSharedSimState] = useState<SystemState>({
    hostname: 'WIN-CLIENT01',
    currentUser: 'Administrator',
    currentGroup: 'Administrators',
    isRootOrAdmin: true,
    umask: 0,
    interfaces: [
      {
        name: 'Ethernet0',
        ip: '169.254.82.114',
        netmask: '255.255.0.0',
        mac: '00-50-56-A1-2B-3C',
        gateway: '',
        dns: ['192.168.1.10'],
        dhcpEnabled: true,
        status: 'UP',
      }
    ],
    processes: [
      { pid: 4, user: 'SYSTEM', cpu: 0.1, mem: 0.1, command: 'System' },
      { pid: 844, user: 'SYSTEM', cpu: 0.5, mem: 22.4, command: 'svchost.exe' },
      { pid: 3892, user: 'Student', cpu: 85.0, mem: 12.0, command: 'svchost_update.exe', port: 4444, isMalicious: true },
    ],
    services: [
      { name: 'Spooler', displayName: 'Print Spooler', status: 'Running', startType: 'Automatic' },
      { name: 'W32Time', displayName: 'Windows Time', status: 'Stopped', startType: 'Automatic' },
      { name: 'LanmanServer', displayName: 'Server (SMB)', status: 'Running', startType: 'Automatic' },
    ],
    disks: [
      {
        diskNumber: 0,
        totalSizeMB: 512000,
        model: 'SAMSUNG 980 NVMe',
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
        sAMAccountName: 'jdoe',
        givenName: 'John',
        surname: 'Doe',
        displayName: 'John Doe',
        email: 'jdoe@corp.local',
        department: 'Marketing',
        ou: 'OU=Marketing,DC=corp,DC=local',
        enabled: true,
        locked: true,
        passwordNeverExpires: false,
        memberOf: ['Domain Users'],
      },
      {
        sAMAccountName: 'administrator',
        givenName: 'Admin',
        surname: 'Account',
        displayName: 'Administrator',
        email: 'admin@corp.local',
        department: 'IT',
        ou: 'OU=IT_Admins,DC=corp,DC=local',
        enabled: true,
        locked: false,
        passwordNeverExpires: true,
        memberOf: ['Domain Users', 'Domain Admins'],
      }
    ],
    adGroups: [
      {
        name: 'Domain Admins',
        scope: 'Global',
        category: 'Security',
        ou: 'OU=IT_Admins,DC=corp,DC=local',
        description: 'Designated administrators',
        members: ['administrator'],
      },
      {
        name: 'Domain Users',
        scope: 'Global',
        category: 'Security',
        ou: 'OU=Users,DC=corp,DC=local',
        description: 'All users',
        members: ['jdoe', 'administrator'],
      }
    ],
    gpos: [
      {
        id: '{31B2F340-016D-11D2-945F-00C04FB984F9}',
        name: 'Default Domain Policy',
        linkedOUs: ['DC=corp,DC=local'],
        status: 'Enabled',
        settings: [
          { category: 'Account Policies/Password Policy', setting: 'Minimum password length', value: '14 characters' },
          { category: 'Account Policies/Password Policy', setting: 'Password must meet complexity requirements', value: 'Enabled' },
        ],
      }
    ],
    installedPackages: ['RSAT-AD-PowerShell', 'GPMC'],
    systemIntegrityCorrupted: true,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: false,
    gatewayWorking: false,
    firewallBlockedPorts: [4444],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: { COMPUTERNAME: 'WIN-CLIENT01', USERNAME: 'Administrator' },
  });

  const allModules = [...LPI_MODULES, ...WINDOWS_PBQS];
  const totalObjectivesCount = allModules.reduce((acc, m) => acc + m.objectives.length, 0);

  const handleObjectiveComplete = (moduleId: string, objectiveId: string) => {
    setProgress(prev => {
      const done = prev[moduleId] ?? [];
      return done.includes(objectiveId) ? prev : { ...prev, [moduleId]: [...done, objectiveId] };
    });
  };

  const completedModuleIds = allModules
    .filter(m => m.objectives.every(o => progress[m.id]?.includes(o.id)))
    .map(m => m.id);
  const completedObjectivesCount = Object.values(progress).reduce((acc, ids) => acc + ids.length, 0);

  const handleNavTab = (tab: AppTab) => {
    setActiveTab(tab);
    if (tab === 'lpi') {
      setSelectedModule(LPI_MODULES[0]);
    } else if (tab === 'comptia') {
      setSelectedModule(WINDOWS_PBQS[0]);
    } else {
      setSelectedModule(null);
    }
  };

  return (
    <div className="h-dvh bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Top Bar Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={handleNavTab}
        completedObjectivesCount={completedObjectivesCount}
        totalObjectivesCount={totalObjectivesCount}
      />

      {/* Main Content Viewport */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        {/* LPI Exam Modules Tab */}
        {activeTab === 'lpi' && (
          selectedModule ? (
            <div className="flex flex-col h-full">
              <div className="bg-slate-950 px-3 sm:px-6 py-2 border-b border-slate-900 flex items-center justify-between gap-3 shrink-0">
                <button
                  onClick={() => setSelectedModule(null)}
                  className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors font-medium"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap">Back<span className="hidden sm:inline"> to LPI Modules Catalog</span></span>
                </button>
                <div className="flex items-center gap-2 overflow-x-auto text-xs">
                  {LPI_MODULES.map(m => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedModule(m)}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors whitespace-nowrap ${
                        selectedModule.id === m.id
                          ? 'bg-amber-500/20 text-amber-300 font-semibold border border-amber-500/40'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                      }`}
                    >
                      {m.topicNumber}
                    </button>
                  ))}
                </div>
              </div>
              <ModuleRunner
                module={selectedModule}
                completedObjectiveIds={progress[selectedModule.id] ?? []}
                onObjectiveComplete={handleObjectiveComplete}
              />
            </div>
          ) : (
            <ModuleSelector
              track="lpi"
              modules={LPI_MODULES}
              completedModuleIds={completedModuleIds}
              onSelectModule={(m) => setSelectedModule(m)}
            />
          )
        )}

        {/* CompTIA Windows PBQs Tab */}
        {activeTab === 'comptia' && (
          selectedModule ? (
            <div className="flex flex-col h-full">
              <div className="bg-slate-950 px-3 sm:px-6 py-2 border-b border-slate-900 flex items-center justify-between gap-3 shrink-0">
                <button
                  onClick={() => setSelectedModule(null)}
                  className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors font-medium"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span className="whitespace-nowrap">Back<span className="hidden sm:inline"> to CompTIA PBQ Catalog</span></span>
                </button>
                <div className="flex items-center gap-2 overflow-x-auto text-xs">
                  {WINDOWS_PBQS.map(m => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedModule(m)}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors whitespace-nowrap ${
                        selectedModule.id === m.id
                          ? 'bg-blue-500/20 text-blue-300 font-semibold border border-blue-500/40'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                      }`}
                    >
                      {m.topicNumber}
                    </button>
                  ))}
                </div>
              </div>
              <ModuleRunner
                module={selectedModule}
                completedObjectiveIds={progress[selectedModule.id] ?? []}
                onObjectiveComplete={handleObjectiveComplete}
              />
            </div>
          ) : (
            <ModuleSelector
              track="comptia-windows"
              modules={WINDOWS_PBQS}
              completedModuleIds={completedModuleIds}
              onSelectModule={(m) => setSelectedModule(m)}
            />
          )
        )}

        {/* Interactive System Simulators Tab */}
        {activeTab === 'simulators' && (
          <SimulatorsHub
            systemState={sharedSimState}
            onUpdateState={setSharedSimState}
          />
        )}

        {/* Freeform Sandbox Tab */}
        {activeTab === 'sandbox' && (
          <SandboxMode />
        )}

        {/* Command Reference Tab */}
        {activeTab === 'reference' && (
          <CommandEncyclopedia />
        )}
      </main>

      {/* Mobile Bottom Navigation Bar (Visible only on small viewports) */}
      <nav className="md:hidden flex items-center justify-around px-2 py-2 bg-slate-900 border-t border-slate-800 shrink-0 text-[10px] font-medium z-40">
        <button
          onClick={() => handleNavTab('lpi')}
          className={`flex flex-col items-center gap-1 px-2 py-1 rounded transition-colors ${
            activeTab === 'lpi' ? 'text-amber-400 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>LPI Labs</span>
        </button>
        <button
          onClick={() => handleNavTab('comptia')}
          className={`flex flex-col items-center gap-1 px-2 py-1 rounded transition-colors ${
            activeTab === 'comptia' ? 'text-blue-400 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>CompTIA</span>
        </button>
        <button
          onClick={() => handleNavTab('simulators')}
          className={`flex flex-col items-center gap-1 px-2 py-1 rounded transition-colors ${
            activeTab === 'simulators' ? 'text-emerald-400 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>Sims</span>
        </button>
        <button
          onClick={() => handleNavTab('sandbox')}
          className={`flex flex-col items-center gap-1 px-2 py-1 rounded transition-colors ${
            activeTab === 'sandbox' ? 'text-purple-400 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>Terminal</span>
        </button>
        <button
          onClick={() => handleNavTab('reference')}
          className={`flex flex-col items-center gap-1 px-2 py-1 rounded transition-colors ${
            activeTab === 'reference' ? 'text-cyan-400 font-bold' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>Ref</span>
        </button>
      </nav>
    </div>
  );
}
