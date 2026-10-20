import { useEffect, useState } from 'react';

/**
 * Hash routes:
 *   #/linux, #/linux/<moduleId>, #/windows, #/windows/<moduleId>,
 *   #/simulators, #/sandbox, #/reference
 * Anything else falls back to #/linux.
 */

export type Section = 'linux' | 'windows' | 'simulators' | 'sandbox' | 'reference';
export type TrackSection = 'linux' | 'windows';

export type Route =
  | { section: TrackSection; moduleId: string | null }
  | { section: 'simulators' | 'sandbox' | 'reference' };

export const DEFAULT_ROUTE: Route = { section: 'linux', moduleId: null };

const SECTIONS: Section[] = ['linux', 'windows', 'simulators', 'sandbox', 'reference'];

export function isTrackSection(section: Section): section is TrackSection {
  return section === 'linux' || section === 'windows';
}

/** Returns null when the hash is not a known route. */
export function parseHash(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(p => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (parts.length === 0) return null;
  const section = parts[0] as Section;
  if (!SECTIONS.includes(section)) return null;
  if (isTrackSection(section)) {
    if (parts.length > 2) return null;
    return { section, moduleId: parts[1] ?? null };
  }
  if (parts.length > 1) return null;
  return { section } as Route;
}

export function routeHref(route: Route): string {
  if ('moduleId' in route && route.moduleId) {
    return `#/${route.section}/${encodeURIComponent(route.moduleId)}`;
  }
  return `#/${route.section}`;
}

export function sameRoute(a: Route, b: Route): boolean {
  return routeHref(a) === routeHref(b);
}

/** Swap the current history entry (no new back-button step). */
export function replaceRoute(route: Route): void {
  const href = routeHref(route);
  if (window.location.hash === href) return;
  try {
    window.history.replaceState(window.history.state, '', href);
  } catch {
    window.location.replace(href);
  }
  // replaceState does not fire hashchange; tell listeners ourselves.
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Current route, kept in sync with the address bar. Unknown hashes are replaced with the default. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash) ?? DEFAULT_ROUTE);

  useEffect(() => {
    const sync = () => {
      const parsed = parseHash(window.location.hash);
      if (!parsed) {
        replaceRoute(DEFAULT_ROUTE);
        return;
      }
      setRoute(prev => (sameRoute(prev, parsed) ? prev : parsed));
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  return route;
}
