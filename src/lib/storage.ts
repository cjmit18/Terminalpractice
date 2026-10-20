/**
 * localStorage wrappers that never throw. Storage can be missing or blocked
 * (private windows, disabled site data, sandboxed previews); the app must keep
 * working without it, so every access goes through these.
 */

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked or full: keep going with in-memory state only.
  }
}
