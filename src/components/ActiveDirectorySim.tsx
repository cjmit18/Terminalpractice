import React, { useEffect, useId, useRef, useState } from 'react';
import { ADUser, SystemState } from '../types/terminal';
import { Ban, CheckCircle2, Folder, Lock, Network, User, UserPlus, Users } from 'lucide-react';
import {
  Button,
  ConsoleTree,
  Notice,
  SimPanel,
  SimToolbar,
  StatusText,
  TreeNode,
  cx,
  inputClass,
  thClass,
  useNotice,
} from './sims/ui';

interface ActiveDirectorySimProps {
  systemState: SystemState;
  onUpdateState: (newState: SystemState) => void;
}

const DOMAIN = 'corp.local';
const ROOT = 'DC=corp,DC=local';

const OUS = [
  { name: 'IT_Admins', path: 'OU=IT_Admins,DC=corp,DC=local', department: 'IT' },
  { name: 'Marketing', path: 'OU=Marketing,DC=corp,DC=local', department: 'Marketing' },
  { name: 'Sales', path: 'OU=Sales,DC=corp,DC=local', department: 'Sales' },
  { name: 'Users', path: 'OU=Users,DC=corp,DC=local', department: 'General' },
];

const TREE: TreeNode[] = [
  { id: ROOT, label: DOMAIN, depth: 0, icon: Network },
  ...OUS.map(ou => ({ id: ou.path, label: ou.name, depth: 1, icon: Folder })),
];

const ouName = (dn: string) => dn.split(',')[0].replace(/^(OU|CN)=/, '');

export const ActiveDirectorySim: React.FC<ActiveDirectorySimProps> = ({
  systemState,
  onUpdateState,
}) => {
  const [selectedOu, setSelectedOu] = useState<string>(ROOT);
  const [selectedSam, setSelectedSam] = useState<string | null>(null);
  const [showNewUser, setShowNewUser] = useState(false);
  const [notice, setNotice] = useNotice();

  const inScope = (ou: string) => selectedOu === ROOT || ou === selectedOu;
  const users = systemState.adUsers.filter(u => inScope(u.ou));
  const groups = systemState.adGroups.filter(g => inScope(g.ou));
  const selectedUser = systemState.adUsers.find(u => u.sAMAccountName === selectedSam) ?? null;

  const updateUser = (sam: string, change: (u: ADUser) => ADUser) =>
    systemState.adUsers.map(u => (u.sAMAccountName.toLowerCase() === sam.toLowerCase() ? change(u) : u));

  const handleUnlockUser = (sam: string) => {
    onUpdateState({ ...systemState, adUsers: updateUser(sam, u => ({ ...u, locked: false })) });
    setNotice(`Unlocked ${sam}. They can sign in again.`);
  };

  const handleToggleDomainAdmins = (sam: string) => {
    const user = systemState.adUsers.find(u => u.sAMAccountName.toLowerCase() === sam.toLowerCase());
    if (!user) return;
    const isAdmin = user.memberOf.includes('Domain Admins');
    const adUsers = updateUser(sam, u => ({
      ...u,
      memberOf: isAdmin ? u.memberOf.filter(g => g !== 'Domain Admins') : [...u.memberOf, 'Domain Admins'],
    }));
    const adGroups = systemState.adGroups.map(g =>
      g.name === 'Domain Admins'
        ? { ...g, members: isAdmin ? g.members.filter(m => m !== sam) : [...g.members.filter(m => m !== sam), sam] }
        : g,
    );
    onUpdateState({ ...systemState, adUsers, adGroups });
    setNotice(isAdmin ? `Removed ${sam} from Domain Admins.` : `Added ${sam} to Domain Admins.`);
  };

  const handleCreateUser = (user: ADUser) => {
    onUpdateState({ ...systemState, adUsers: [...systemState.adUsers, user] });
    setShowNewUser(false);
    setSelectedOu(user.ou);
    setSelectedSam(user.sAMAccountName);
    setNotice(`Created ${user.displayName} in ${ouName(user.ou)}.`);
  };

  const statusFor = (u: ADUser) => {
    if (u.locked) return <StatusText tone="danger" icon={Lock}>Locked</StatusText>;
    if (!u.enabled) return <StatusText tone="muted" icon={Ban}>Disabled</StatusText>;
    return <StatusText tone="ok" icon={CheckCircle2}>Enabled</StatusText>;
  };

  const scopeLabel = selectedOu === ROOT ? DOMAIN : ouName(selectedOu);
  const count = users.length + groups.length;

  return (
    <SimPanel label="Active Directory Users and Computers">
      <SimToolbar
        title="Active Directory Users and Computers"
        context={<span className="font-mono">dc01.{DOMAIN}</span>}
      >
        <Button variant="secondary" onClick={() => setShowNewUser(true)}>
          <UserPlus className="h-4 w-4" aria-hidden />
          New user
        </Button>
      </SimToolbar>
      <Notice message={notice} onDismiss={() => setNotice(null)} />

      <div className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
        <ConsoleTree
          id="aduc-container"
          label="Container"
          nodes={TREE}
          selectedId={selectedOu}
          onSelect={id => setSelectedOu(id)}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-line px-4 py-2 text-sm">
            <span className="font-medium">{scopeLabel}</span>
            <span className="text-muted">{count === 1 ? '1 object' : `${count} objects`}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Objects in {scopeLabel}</caption>
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-line">
                  <th scope="col" className={thClass}>Name</th>
                  <th scope="col" className={cx(thClass, 'hidden @2xl:table-cell')}>Type</th>
                  <th scope="col" className={thClass}>Description / status</th>
                  <th scope="col" className={cx(thClass, 'hidden text-right @xl:table-cell')}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => {
                  const isSel = user.sAMAccountName === selectedSam;
                  const isAdmin = user.memberOf.includes('Domain Admins');
                  const actions = (
                    <>
                      {user.locked && (
                        <Button variant="quiet" onClick={() => handleUnlockUser(user.sAMAccountName)}>
                          Unlock
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        onClick={() => handleToggleDomainAdmins(user.sAMAccountName)}
                        aria-label={
                          isAdmin
                            ? `Remove ${user.sAMAccountName} from Domain Admins`
                            : `Add ${user.sAMAccountName} to Domain Admins`
                        }
                      >
                        {isAdmin ? 'Remove admin' : 'Make admin'}
                      </Button>
                    </>
                  );
                  return (
                    <tr
                      key={user.sAMAccountName}
                      className={cx('border-b border-line align-middle', isSel ? 'bg-accent-soft' : 'hover:bg-surface-2')}
                    >
                      <th scope="row" className="px-3 py-1.5 text-left font-normal">
                        <button
                          type="button"
                          onClick={() => setSelectedSam(isSel ? null : user.sAMAccountName)}
                          aria-pressed={isSel}
                          className="flex min-h-10 items-center gap-2 text-left sm:min-h-8"
                        >
                          <User className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                          <span>
                            <span className="font-medium">{user.displayName}</span>
                            <span className="ml-1.5 font-mono text-xs text-muted">{user.sAMAccountName}</span>
                          </span>
                        </button>
                        {/* In a narrow pane the actions sit under the name instead of in their own column */}
                        <div className="-ml-2 flex flex-wrap gap-1 @xl:hidden">{actions}</div>
                      </th>
                      <td className="hidden px-3 py-1.5 text-muted @2xl:table-cell">User</td>
                      <td className="px-3 py-1.5">{statusFor(user)}</td>
                      <td className="hidden px-2 py-1.5 text-right @xl:table-cell">
                        <div className="flex flex-wrap justify-end gap-1">{actions}</div>
                      </td>
                    </tr>
                  );
                })}
                {groups.map(group => (
                  <tr key={group.name} className="border-b border-line align-middle hover:bg-surface-2">
                    <th scope="row" className="px-3 py-1.5 text-left font-normal">
                      <span className="flex min-h-10 items-center gap-2 sm:min-h-8">
                        <Users className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                        <span className="font-medium">{group.name}</span>
                      </span>
                    </th>
                    <td className="hidden px-3 py-1.5 text-muted @2xl:table-cell">
                      {group.category} group, {group.scope === 'DomainLocal' ? 'domain local' : group.scope.toLowerCase()}
                    </td>
                    <td className="px-3 py-1.5 text-muted">
                      {group.description}
                      {' · '}
                      {group.members.length === 1 ? '1 member' : `${group.members.length} members`}
                    </td>
                    <td className="hidden @xl:table-cell" />
                  </tr>
                ))}
                {count === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-muted">
                      There are no objects in {scopeLabel} yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {selectedUser && (
            <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-line px-4 py-3">
              <h3 className="text-base font-semibold">{selectedUser.displayName}</h3>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm @xl:grid-cols-[auto_1fr]">
                <dt className="text-muted">Logon name</dt>
                <dd className="font-mono">{selectedUser.sAMAccountName}@{DOMAIN}</dd>
                <dt className="text-muted">Distinguished name</dt>
                <dd className="break-all font-mono">CN={selectedUser.displayName},{selectedUser.ou}</dd>
                <dt className="text-muted">Department</dt>
                <dd>{selectedUser.department}</dd>
                <dt className="text-muted">Account</dt>
                <dd>
                  {statusFor(selectedUser)}
                  {selectedUser.passwordNeverExpires && <span className="text-muted"> · Password never expires</span>}
                </dd>
                <dt className="text-muted">Member of</dt>
                <dd>{selectedUser.memberOf.join(', ')}</dd>
              </dl>
            </div>
          )}
        </div>
      </div>

      {showNewUser && (
        <NewUserDialog
          defaultOu={selectedOu === ROOT ? OUS[0].path : selectedOu}
          existing={systemState.adUsers.map(u => u.sAMAccountName.toLowerCase())}
          onCancel={() => setShowNewUser(false)}
          onCreate={handleCreateUser}
        />
      )}
    </SimPanel>
  );
};

const NewUserDialog: React.FC<{
  defaultOu: string;
  existing: string[];
  onCancel: () => void;
  onCreate: (u: ADUser) => void;
}> = ({ defaultOu, existing, onCancel, onCreate }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const fid = useId();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [sam, setSam] = useState('');
  const [ou, setOu] = useState(defaultOu);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const logon = sam.trim();
    if (!/^[A-Za-z0-9._-]{1,20}$/.test(logon)) {
      setError('Use up to 20 letters, digits, dots, dashes or underscores, with no spaces.');
      return;
    }
    if (existing.includes(logon.toLowerCase())) {
      setError(`There is already an account called ${logon}.`);
      return;
    }
    const given = first.trim();
    const surname = last.trim();
    const displayName = [given, surname].filter(Boolean).join(' ') || logon;
    onCreate({
      sAMAccountName: logon,
      givenName: given || logon,
      surname,
      displayName,
      email: `${logon}@${DOMAIN}`,
      department: OUS.find(o => o.path === ou)?.department ?? 'General',
      ou,
      enabled: true,
      locked: false,
      passwordNeverExpires: false,
      memberOf: ['Domain Users'],
    });
  };

  return (
    <dialog
      ref={ref}
      onCancel={e => {
        e.preventDefault();
        onCancel();
      }}
      aria-labelledby={`${fid}-title`}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-md border border-line bg-surface p-0 text-text shadow-lg backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="space-y-4 p-5">
        <div>
          <h2 id={`${fid}-title`} className="text-base font-semibold">New user</h2>
          <p className="mt-0.5 text-sm text-muted">The account starts enabled and joins Domain Users.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${fid}-first`} className="block text-sm font-medium">First name</label>
            <input id={`${fid}-first`} value={first} onChange={e => setFirst(e.target.value)} className={cx(inputClass, 'mt-1 w-full')} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${fid}-last`} className="block text-sm font-medium">Last name</label>
            <input id={`${fid}-last`} value={last} onChange={e => setLast(e.target.value)} className={cx(inputClass, 'mt-1 w-full')} autoComplete="off" />
          </div>
        </div>

        <div>
          <label htmlFor={`${fid}-sam`} className="block text-sm font-medium">User logon name</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id={`${fid}-sam`}
              value={sam}
              onChange={e => {
                setSam(e.target.value);
                setError(null);
              }}
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${fid}-sam-help`}
              className={cx(inputClass, 'w-full min-w-0 font-mono')}
              placeholder="achen"
            />
            <span className="shrink-0 font-mono text-sm text-muted">@{DOMAIN}</span>
          </div>
          <p id={`${fid}-sam-help`} className={cx('mt-1 text-sm', error ? 'text-danger' : 'text-muted')}>
            {error ?? 'This is the sAMAccountName people type to sign in.'}
          </p>
        </div>

        <div>
          <label htmlFor={`${fid}-ou`} className="block text-sm font-medium">Create in</label>
          <select id={`${fid}-ou`} value={ou} onChange={e => setOu(e.target.value)} className={cx(inputClass, 'mt-1 w-full')}>
            {OUS.map(o => (
              <option key={o.path} value={o.path}>
                {o.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit">Create user</Button>
        </div>
      </form>
    </dialog>
  );
};
