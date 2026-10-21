import { ComponentType, lazy } from 'react';

/**
 * After a deploy, a tab still running the previous build asks for lazy chunks that are no longer on
 * the server (and a host's SPA fallback may answer with index.html, which fails as a module script).
 * Reloading once loads the new build. A timestamp in sessionStorage stops a reload loop when the
 * chunk is missing for some other reason: then the error boundary shows a Reload button instead.
 */
const KEY = 'certsim:chunk-reload';
const GUARD_MS = 60_000;
let reloading = false;

/** Reloads the page unless this tab already did so in the last minute. True when a reload is under way. */
export function reloadForNewBuild(): boolean {
  if (reloading) return true;
  try {
    const last = Number(window.sessionStorage.getItem(KEY)) || 0;
    if (Date.now() - last < GUARD_MS) return false;
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // No sessionStorage: without the guard a reload could loop, so do not reload
    return false;
  }
  reloading = true;
  window.location.reload();
  return true;
}

let listening = false;

/** Vite fires vite:preloadError when a dynamic import's chunk or CSS fails to load. */
export function reloadOnPreloadError(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('vite:preloadError', () => {
    reloadForNewBuild();
  });
}

/** React.lazy that reloads once when the chunk fails to load; if it cannot, the error reaches the error boundary. */
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((err: unknown) => {
      // Keep the Suspense fallback up while the page reloads
      if (reloadForNewBuild()) return new Promise<{ default: T }>(() => {});
      throw err;
    }),
  );
}
