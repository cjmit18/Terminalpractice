import { useEffect, useState } from 'react';

/**
 * Hash routes:
 *   #/learn, #/learn/<pathId>, #/learn/<pathId>/<stepId>,
 *   #/linux, #/linux/<moduleId>, #/windows, #/windows/<moduleId>,
 *   #/simulators, #/sandbox, #/reference, #/badge/<badgeId>
 * Anything else falls back to #/learn.
 */

export type Section = 'learn' | 'linux' | 'windows' | 'simulators' | 'sandbox' | 'reference';
export type TrackSection = 'linux' | 'windows';

export type Route =
  | { section: 'learn'; pathId: string | null; stepId: string | null }
  | { section: TrackSection; moduleId: string | null }
  | { section: 'simulators' | 'sandbox' | 'reference' }
  /** #/badge/<badgeId>: what one badge means. Not a nav section; the link carries no personal data */
  | { section: 'badge'; badgeId: string };

/** Every page's section, including pages that are not in the nav */
export type RouteSection = Route['section'];

/** The nav section a page belongs to (a badge page sits with the badges on Learn) */
export function navSection(section: RouteSection): Section {
  return section === 'badge' ? 'learn' : section;
}

export function badgeHref(badgeId: string): string {
  return routeHref({ section: 'badge', badgeId });
}

export const DEFAULT_ROUTE: Route = { section: 'learn', pathId: null, stepId: null };

const SECTIONS: Section[] = ['learn', 'linux', 'windows', 'simulators', 'sandbox', 'reference'];

export function isTrackSection(section: RouteSection): section is TrackSection {
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
  if (parts[0] === 'badge') return parts.length === 2 ? { section: 'badge', badgeId: parts[1] } : null;
  const section = parts[0] as Section;
  if (!SECTIONS.includes(section)) return null;
  if (section === 'learn') {
    if (parts.length > 3) return null;
    return { section, pathId: parts[1] ?? null, stepId: parts[2] ?? null };
  }
  if (isTrackSection(section)) {
    if (parts.length > 2) return null;
    return { section, moduleId: parts[1] ?? null };
  }
  if (parts.length > 1) return null;
  return { section } as Route;
}

export function routeHref(route: Route): string {
  if (route.section === 'learn') {
    const segs = ['learn'];
    if (route.pathId) {
      segs.push(encodeURIComponent(route.pathId));
      if (route.stepId) segs.push(encodeURIComponent(route.stepId));
    }
    return `#/${segs.join('/')}`;
  }
  if (route.section === 'badge') return `#/badge/${encodeURIComponent(route.badgeId)}`;
  if ('moduleId' in route && route.moduleId) {
    return `#/${route.section}/${encodeURIComponent(route.moduleId)}`;
  }
  return `#/${route.section}`;
}

/** Shorthand for learning path links. */
export function learnHref(pathId?: string | null, stepId?: string | null): string {
  return routeHref({ section: 'learn', pathId: pathId ?? null, stepId: pathId ? stepId ?? null : null });
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
