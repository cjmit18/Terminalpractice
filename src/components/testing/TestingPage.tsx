import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { TestNote } from '../../data/testing/types';
import { LEARNING_PATHS } from '../../data/paths';
import { CHALLENGES } from '../../data/challenges';
import { TRACK_MODULES, topicLabel } from '../../lib/modules';
import { learnHref, reviewHref, routeHref } from '../../lib/router';
import { secondaryLinkClass } from '../journey/shared';

/** Every src/data/testing/pr-*.ts note, newest PR first */
const NOTES: TestNote[] = Object.values(import.meta.glob<{ default: TestNote }>('../../data/testing/pr-*.ts', { eager: true }))
  .map(m => m.default)
  .sort((a, b) => b.pr - a.pr);

/** Written by the test-site workflow next to index.html: which pull requests this build holds */
interface BuildInfo {
  builtAt: string;
  main: string;
  included: { number: number; title: string; url: string }[];
  skipped: { number: number; title: string; url: string; reason: string }[];
}

const REPO = 'https://github.com/cjmit18/Terminalpractice';
const linkClass = 'text-accent underline-offset-2 hover:underline';

/** #/testing, on the test site only: what this build holds, what to try, and a link to every part of the app. */
export const TestingPage: React.FC = () => {
  const [build, setBuild] = useState<BuildInfo | null | 'none'>(null);
  useEffect(() => {
    let live = true;
    fetch('./test-site.json', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : 'none'))
      .then(b => live && setBuild(b), () => live && setBuild('none'));
    return () => {
      live = false;
    };
  }, []);

  const clearProgress = () => {
    if (!window.confirm('Clear all progress, badges and settings saved in this browser for this site?')) return;
    for (const k of Object.keys(localStorage)) if (k.startsWith('certsim:')) localStorage.removeItem(k);
    window.location.reload();
  };

  return (
    <div className="max-w-5xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 space-y-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Test this site</h1>
        <p className="text-[15px] text-muted max-w-prose">
          This private test site has the live site plus every open pull request. Try the new things below, then anything
          else from the full list. Progress here is separate from terminuscli.com.
        </p>
      </header>

      <section aria-labelledby="build-heading" className="space-y-3">
        <h2 id="build-heading" className="text-base font-semibold">In this build</h2>
        {build === null && <p className="text-sm text-muted">Loading…</p>}
        {build === 'none' && (
          <p className="text-sm text-muted">Build details appear here once the test-site workflow has built this site.</p>
        )}
        {build && build !== 'none' && (
          <div className="text-sm space-y-2">
            <p className="text-muted">
              Built {new Date(build.builtAt).toLocaleString()} from main {build.main.slice(0, 7)}
              {build.included.length === 0 ? ', with no open pull requests.' : ', plus:'}
            </p>
            <ul className="space-y-1">
              {build.included.map(p => (
                <li key={p.number}>
                  <a href={p.url} target="_blank" rel="noreferrer" className={linkClass}>#{p.number}</a> {p.title}
                </li>
              ))}
            </ul>
            {build.skipped.length > 0 && (
              <>
                <p className="text-muted">Left out of this build:</p>
                <ul className="space-y-1">
                  {build.skipped.map(p => (
                    <li key={p.number}>
                      <a href={p.url} target="_blank" rel="noreferrer" className={linkClass}>#{p.number}</a> {p.title}: {p.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="new-heading" className="space-y-4">
        <h2 id="new-heading" className="text-base font-semibold">New to try</h2>
        <ul className="grid gap-4 md:grid-cols-2">
          {NOTES.map(n => (
            <li key={n.pr} className="rounded-md border border-line bg-surface p-4 space-y-2">
              <p className="text-sm text-muted">
                <a href={`${REPO}/pull/${n.pr}`} target="_blank" rel="noreferrer" className={`${linkClass} inline-flex items-center gap-1`}>
                  #{n.pr}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </p>
              <h3 className="text-[15px] font-semibold">{n.title}</h3>
              <ol className="list-decimal pl-5 text-sm space-y-1">
                {n.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              <p className="flex flex-wrap gap-2 pt-1">
                {n.links.map(l => (
                  <a key={l.href} href={l.href} className={secondaryLinkClass}>{l.label}</a>
                ))}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="all-heading" className="space-y-4">
        <h2 id="all-heading" className="text-base font-semibold">Everything in the app</h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <LinkList
            title="Learning paths"
            links={[...LEARNING_PATHS.map(p => ({ label: p.title, href: learnHref(p.id) })), { label: 'Review', href: reviewHref() }]}
          />
          <LinkList title="Linux labs" links={TRACK_MODULES.linux.map(m => ({ label: `${topicLabel(m)} ${m.title}`, href: routeHref({ section: 'linux', moduleId: m.id }) }))} />
          <LinkList title="Windows labs" links={TRACK_MODULES.windows.map(m => ({ label: `${topicLabel(m)} ${m.title}`, href: routeHref({ section: 'windows', moduleId: m.id }) }))} />
          <LinkList
            title="Challenges"
            links={[
              { label: 'All challenges', href: routeHref({ section: 'sandbox', challengeId: null }) },
              ...CHALLENGES.map(c => ({ label: c.title, href: routeHref({ section: 'sandbox', challengeId: c.id }) })),
            ]}
          />
          <LinkList
            title="Tools"
            links={[
              { label: 'Sandbox', href: routeHref({ section: 'sandbox' }) },
              { label: 'Simulators', href: routeHref({ section: 'simulators' }) },
              { label: 'Command reference', href: routeHref({ section: 'reference' }) },
            ]}
          />
        </div>
      </section>

      <section aria-labelledby="tools-heading" className="space-y-3">
        <h2 id="tools-heading" className="text-base font-semibold">Start over</h2>
        <p className="text-sm text-muted max-w-prose">To see first-visit screens again, clear what this browser saved for this site.</p>
        <button type="button" onClick={clearProgress} className={secondaryLinkClass}>Clear this browser's progress</button>
      </section>
    </div>
  );
};

const LinkList: React.FC<{ title: string; links: { label: string; href: string }[] }> = ({ title, links }) => (
  <div className="space-y-2">
    <h3 className="font-semibold">{title}</h3>
    <ul className="space-y-1">
      {links.map(l => (
        <li key={l.href}>
          <a href={l.href} className={linkClass}>{l.label}</a>
        </li>
      ))}
    </ul>
  </div>
);
