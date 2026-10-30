import React, { useCallback, useEffect, useId, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { addAdmin, getAdminStats, listAdmins, removeAdmin, type AdminEntry, type AdminStats } from '../../lib/admin';
import { accountHref, learnHref } from '../../lib/router';
import { setViewAs, useDisplayAccount, type ViewAs } from '../../lib/viewAs';
import { Field, FormError, FormNote, secondaryButton, textLink } from '../account/forms';
import { emailError, normalizeEmail } from '../account/messages';

const sectionClass = 'space-y-4 pt-8 border-t border-line first:pt-0 first:border-t-0';
const headingClass = 'text-base font-semibold text-text';

/** #/admin: totals for the site's admins, the admin list for the owner, and "view as". */
export const AdminPage: React.FC = () => {
  const { account, role } = useDisplayAccount();
  let body: React.ReactNode;
  if (account.status === 'loading') body = <p className="text-sm text-muted">Loading…</p>;
  else if (!role) {
    body = (
      <p className="text-[15px] text-muted max-w-prose">
        This page is for the site’s admins.{' '}
        {account.status === 'signed-out' ? (
          <a href={accountHref()} className={textLink}>
            Sign in
          </a>
        ) : (
          <a href={learnHref()} className={textLink}>
            Back to the learning paths
          </a>
        )}
      </p>
    );
  } else {
    body = (
      <div className="space-y-8 max-w-2xl">
        <Totals />
        {role === 'owner' && <Admins />}
        <ViewAsChooser />
      </div>
    );
  }
  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <h1 className="text-2xl font-semibold text-text">Admin dashboard</h1>
      {body}
    </div>
  );
};

const Totals: React.FC = () => {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    const r = await getAdminStats();
    setBusy(false);
    if (r.ok) {
      setStats(r.data);
      setError(null);
    } else setError(r.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const rows: [string, [string, number][]][] = stats
    ? [
        [
          'Accounts',
          [
            ['Learner accounts', stats.accounts.total],
            ['New in the last 7 days', stats.accounts.newLast7Days],
            ['New in the last 30 days', stats.accounts.newLast30Days],
            ['Email confirmed', stats.accounts.emailConfirmed],
            ['Sign in with a password', stats.accounts.withPassword],
            ['Sign in with GitHub', stats.accounts.withGithub],
          ],
        ],
        [
          'Activity',
          [
            ['Signed in during the last 7 days', stats.activity.signedInLast7Days],
            ['Live sessions', stats.activity.liveSessions],
          ],
        ],
        [
          'Saved progress',
          [
            ['Accounts with progress', stats.progress.accountsWithProgress],
            ['Lab tasks done', stats.progress.tasksDone],
            ['Lessons read', stats.progress.lessonsRead],
            ['Quizzes taken', stats.progress.quizzesTaken],
          ],
        ],
      ]
    : [];

  return (
    <section aria-labelledby="totals-h" className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="totals-h" className={headingClass}>
          Totals
        </h2>
        <button type="button" onClick={() => void load()} disabled={busy} className={secondaryButton}>
          <RefreshCw className={`size-4 ${busy ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
          Refresh
        </button>
      </div>
      <p className="text-sm text-muted">
        Learner accounts only: you and the other admins are never counted. Totals only, never names or addresses.
        {stats && ` As of ${new Date(stats.asOf).toLocaleString()}.`}
      </p>
      {error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {rows.map(([group, items]) => (
        <table key={group} className="w-full text-[15px]">
          <caption className="text-left text-sm font-medium text-muted pb-1">{group}</caption>
          <tbody className="divide-y divide-line border-y border-line">
            {items.map(([label, n]) => (
              <tr key={label}>
                <th scope="row" className="py-2 pr-4 text-left font-normal text-text">
                  {label}
                </th>
                <td className="py-2 text-right font-mono tabular-nums">{n.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
};

const Admins: React.FC = () => {
  const [list, setList] = useState<AdminEntry[] | null>(null);
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await listAdmins();
    if (r.ok) setList(r.data.admins);
    else setError(r.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    setError(null);
    const problem = emailError(email);
    setFieldError(problem ?? undefined);
    if (problem) return;
    // As the server stores it (lowercase), so the list and the note show the same address
    const address = normalizeEmail(email).toLowerCase();
    setBusy(true);
    const r = await addAdmin(address);
    setBusy(false);
    if (!r.ok) return r.field === 'email' ? setFieldError(r.message) : setError(r.message);
    setEmail('');
    setNote(`${address} is now an admin, once that account’s email is confirmed.`);
    void load();
  };
  const remove = async (address: string) => {
    setNote(null);
    setError(null);
    setBusy(true);
    const r = await removeAdmin(address);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNote(`${address} is no longer an admin.`);
    void load();
  };

  return (
    <section aria-labelledby="admins-h" className={sectionClass}>
      <h2 id="admins-h" className={headingClass}>
        Admins
      </h2>
      <p className="text-sm text-muted">
        Admins see this page. An address counts once its account has confirmed it. You are always the owner, set by
        the site’s settings.
      </p>
      {list && list.length === 0 && <p className="text-sm text-muted">No other admins yet.</p>}
      {list && list.length > 0 && (
        <ul className="divide-y divide-line border-y border-line" aria-label="Admins">
          {list.map(a => (
            <li key={a.email} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="min-w-0 break-all text-[15px]">{a.email}</span>
              <button type="button" onClick={() => remove(a.email)} disabled={busy} aria-label={`Remove ${a.email}`} className={secondaryButton}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} noValidate className="space-y-3">
        <FormError message={error} />
        <Field label="Add an admin by email" type="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} error={fieldError} />
        <button type="submit" disabled={busy} className={secondaryButton}>
          Add admin
        </button>
        <FormNote message={note} />
      </form>
    </section>
  );
};

const VIEWS: { value: ViewAs; label: string; hint: string }[] = [
  { value: 'signed-out', label: 'A signed-out visitor', hint: 'Sign in shows in the header; the account pages show sign-in.' },
  { value: 'learner', label: 'A learner', hint: 'Your account, without the admin link.' },
];

const ViewAsChooser: React.FC = () => {
  const id = useId();
  return (
    <section aria-labelledby="viewas-h" className={sectionClass}>
      <h2 id="viewas-h" className={headingClass}>
        View the site as
      </h2>
      <p className="text-sm text-muted">
        Changes only what this tab shows. Your account stays signed in and keeps syncing, and a banner takes you back.
      </p>
      <ul className="space-y-2">
        {VIEWS.map(v => (
          <li key={v.value}>
            <button
              type="button"
              aria-describedby={`${id}-${v.value}`}
              onClick={() => {
                setViewAs(v.value);
                window.location.hash = learnHref();
              }}
              className={secondaryButton}
            >
              View as {v.label.toLowerCase()}
            </button>
            <p id={`${id}-${v.value}`} className="mt-1 text-sm text-muted">
              {v.hint}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};
