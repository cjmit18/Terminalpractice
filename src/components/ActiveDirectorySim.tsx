import React, { useState } from 'react';
import { ADUser, ADGroup, SystemState } from '../types/terminal';
import { Folder, Users, User, Shield, Lock, Unlock, Key, Plus, CheckCircle, AlertTriangle } from 'lucide-react';

interface ActiveDirectorySimProps {
  systemState: SystemState;
  onUpdateState: (newState: SystemState) => void;
}

export const ActiveDirectorySim: React.FC<ActiveDirectorySimProps> = ({
  systemState,
  onUpdateState,
}) => {
  const [selectedOu, setSelectedOu] = useState<string>('All');
  const [selectedUser, setSelectedUser] = useState<ADUser | null>(null);
  const [showNewUserModal, setShowNewUserModal] = useState(false);
  const [newSam, setNewSam] = useState('');
  const [newName, setNewName] = useState('');
  const [newOu, setNewOu] = useState('OU=IT_Admins,DC=corp,DC=local');
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const ous = [
    { name: 'All Objects', path: 'All' },
    { name: 'IT_Admins', path: 'OU=IT_Admins,DC=corp,DC=local' },
    { name: 'Marketing', path: 'OU=Marketing,DC=corp,DC=local' },
    { name: 'Sales', path: 'OU=Sales,DC=corp,DC=local' },
    { name: 'Users', path: 'OU=Users,DC=corp,DC=local' },
  ];

  const filteredUsers = selectedOu === 'All'
    ? systemState.adUsers
    : systemState.adUsers.filter(u => u.ou === selectedOu);

  const handleUnlockUser = (sam: string) => {
    const updated = systemState.adUsers.map(u => {
      if (u.sAMAccountName.toLowerCase() === sam.toLowerCase()) {
        return { ...u, locked: false };
      }
      return u;
    });
    onUpdateState({ ...systemState, adUsers: updated });
    if (selectedUser && selectedUser.sAMAccountName === sam) {
      setSelectedUser({ ...selectedUser, locked: false });
    }
    setActionNotice(`Account "${sam}" was successfully unlocked.`);
    setTimeout(() => setActionNotice(null), 3000);
  };

  const handleToggleDomainAdmins = (sam: string) => {
    let updatedGroups = [...systemState.adGroups];
    const adminGrp = updatedGroups.find(g => g.name === 'Domain Admins');
    const updatedUsers = systemState.adUsers.map(u => {
      if (u.sAMAccountName.toLowerCase() === sam.toLowerCase()) {
        const has = u.memberOf.includes('Domain Admins');
        const nextGroups = has
          ? u.memberOf.filter(g => g !== 'Domain Admins')
          : [...u.memberOf, 'Domain Admins'];
        return { ...u, memberOf: nextGroups };
      }
      return u;
    });

    if (adminGrp) {
      const has = adminGrp.members.includes(sam);
      adminGrp.members = has
        ? adminGrp.members.filter(m => m !== sam)
        : [...adminGrp.members, sam];
    }

    onUpdateState({
      ...systemState,
      adUsers: updatedUsers,
      adGroups: updatedGroups,
    });
    const nowHas = !selectedUser?.memberOf.includes('Domain Admins');
    setActionNotice(nowHas ? `Added "${sam}" to Domain Admins.` : `Removed "${sam}" from Domain Admins.`);
    setTimeout(() => setActionNotice(null), 3000);
  };

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSam.trim()) return;

    const user: ADUser = {
      sAMAccountName: newSam.trim(),
      givenName: newName.split(' ')[0] || newSam,
      surname: newName.split(' ')[1] || 'User',
      displayName: newName.trim() || newSam.trim(),
      email: `${newSam.trim()}@corp.local`,
      department: 'IT Infrastructure',
      ou: newOu,
      enabled: true,
      locked: false,
      passwordNeverExpires: false,
      memberOf: ['Domain Users'],
    };

    onUpdateState({
      ...systemState,
      adUsers: [...systemState.adUsers, user],
    });
    setShowNewUserModal(false);
    setNewSam('');
    setNewName('');
    setActionNotice(`Provisioned new user account "${user.displayName}".`);
    setTimeout(() => setActionNotice(null), 3000);
  };

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl text-xs font-sans">
      {/* MMC Window Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-blue-400" />
          <span className="font-semibold text-slate-200">Active Directory Users and Computers [dc01.corp.local]</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewUserModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New User</span>
          </button>
        </div>
      </div>

      {actionNotice && (
        <div className="px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 flex items-center gap-2 text-xs">
          <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{actionNotice}</span>
        </div>
      )}

      {/* Main MMC Split Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Tree Pane (OUs) */}
        <div className="w-52 border-r border-slate-800 bg-slate-950/60 p-3 overflow-y-auto space-y-1">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
            corp.local
          </div>
          {ous.map((ou) => (
            <button
              key={ou.path}
              onClick={() => setSelectedOu(ou.path)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
                selectedOu === ou.path
                  ? 'bg-blue-500/20 text-blue-300 font-medium'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Folder className="w-3.5 h-3.5 text-amber-400" />
              <span className="truncate">{ou.name}</span>
            </button>
          ))}

          <div className="pt-4 border-t border-slate-800/80 mt-4 space-y-1">
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Security Groups
            </div>
            {systemState.adGroups.map((grp) => (
              <div key={grp.name} className="flex items-center gap-2 px-2.5 py-1 text-slate-400">
                <Users className="w-3.5 h-3.5 text-blue-400" />
                <span className="truncate">{grp.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right Object List Pane */}
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-900/40">
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/40 text-[11px] text-slate-400 font-semibold">
                  <th className="py-2.5 px-3">Name</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">OU Location</th>
                  <th className="py-2.5 px-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50 text-xs text-slate-300">
                {filteredUsers.map((user) => {
                  const isDomainAdmin = user.memberOf.includes('Domain Admins');
                  return (
                    <tr
                      key={user.sAMAccountName}
                      onClick={() => setSelectedUser(user)}
                      className={`hover:bg-slate-800/40 cursor-pointer transition-colors ${
                        selectedUser?.sAMAccountName === user.sAMAccountName ? 'bg-blue-500/10' : ''
                      }`}
                    >
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2 font-medium text-slate-200">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          <span>{user.displayName}</span>
                          <span className="text-[11px] text-slate-500 font-mono">({user.sAMAccountName})</span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="text-slate-400">User Object</span>
                      </td>
                      <td className="py-2.5 px-3">
                        {user.locked ? (
                          <span className="inline-flex items-center gap-1 text-rose-400 font-medium">
                            <Lock className="w-3 h-3" /> Locked Out
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle className="w-3 h-3" /> Normal
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="text-slate-400 truncate block max-w-[150px] font-mono text-[11px]">
                          {user.ou.split(',')[0]}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {user.locked && (
                            <button
                              onClick={() => handleUnlockUser(user.sAMAccountName)}
                              className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-[11px] font-medium"
                            >
                              Unlock
                            </button>
                          )}
                          <button
                            onClick={() => handleToggleDomainAdmins(user.sAMAccountName)}
                            className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                              isDomainAdmin
                                ? 'bg-purple-500/20 text-purple-300 border-purple-500/30'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                            }`}
                          >
                            {isDomainAdmin ? 'Domain Admin' : '+ Domain Admin'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* User Details Inspector Footer */}
          {selectedUser && (
            <div className="p-3 border-t border-slate-800 bg-slate-950/80">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-slate-200 flex items-center gap-2">
                  <User className="w-4 h-4 text-blue-400" />
                  <span>Properties: {selectedUser.displayName}</span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  sAMAccountName: {selectedUser.sAMAccountName}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span className="text-slate-400">Distinguished Name:</span>{' '}
                  <span className="text-slate-300 font-mono">CN={selectedUser.displayName},{selectedUser.ou}</span>
                </div>
                <div>
                  <span className="text-slate-400">Member Of:</span>{' '}
                  <span className="text-blue-300 font-semibold">{selectedUser.memberOf.join(', ')}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* New User Modal */}
      {showNewUserModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-2xl">
            <h3 className="text-sm font-bold text-white mb-3">New Object - User</h3>
            <form onSubmit={handleCreateUser} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Full Name</label>
                <input
                  type="text"
                  placeholder="e.g. Alex Chen"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">User logon name (samAccountName)</label>
                <input
                  type="text"
                  placeholder="e.g. alex"
                  value={newSam}
                  onChange={(e) => setNewSam(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Organizational Unit (OU)</label>
                <select
                  value={newOu}
                  onChange={(e) => setNewOu(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                >
                  <option value="OU=IT_Admins,DC=corp,DC=local">OU=IT_Admins,DC=corp,DC=local</option>
                  <option value="OU=Marketing,DC=corp,DC=local">OU=Marketing,DC=corp,DC=local</option>
                  <option value="OU=Sales,DC=corp,DC=local">OU=Sales,DC=corp,DC=local</option>
                  <option value="OU=Users,DC=corp,DC=local">OU=Users,DC=corp,DC=local</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewUserModal(false)}
                  className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs"
                >
                  Create User
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
