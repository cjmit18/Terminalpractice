import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { readStorage, writeStorage } from './storage';

/** How a value is read from, merged with and written to one localStorage key. */
export interface SyncedCodec<T> {
  /** Parse saved text (null when the key is missing); never throws, bad data gives an empty value. */
  parse(text: string | null): T;
  /** Combine what is in storage now with this tab's copy. Must be idempotent and give canonical output. */
  merge(stored: T, mine: T): T;
  /** Text to save, or null to remove the key. Equal values must give equal text. */
  serialize(value: T): string | null;
}

/**
 * React state kept in localStorage and shared with other tabs of the app.
 *
 * - Every save reads storage again and merges it with this tab's state, so a tab never writes its
 *   whole stale copy over what another tab saved. Nothing is written when the merged text is
 *   already what is stored, so tabs do not echo each other's writes back and forth.
 * - A `storage` event (another tab wrote the key) is merged into this tab's state at once.
 * - Opening the app writes nothing: until this tab changes something, what is stored stays as it is.
 *
 * The third value is true while the latest change came from another tab (a `storage` event) and
 * false after this tab's own setter; a reader may set it back to false once it has looked.
 *
 * The codec must be stable (create it once, outside the component).
 */
export function useSyncedStorage<T>(key: string, codec: SyncedCodec<T>): [T, Dispatch<SetStateAction<T>>, MutableRefObject<boolean>] {
  const [state, setState] = useState<T>(() => codec.parse(readStorage(key)));
  // The value read on load: saving it back would change nothing this tab did
  const loaded = useRef(state);
  const fromOtherTab = useRef(false);
  const setLocal = useCallback<Dispatch<SetStateAction<T>>>(value => {
    fromOtherTab.current = false;
    setState(value);
  }, []);

  useEffect(() => {
    if (state === loaded.current) return;
    const storedText = readStorage(key);
    const merged = codec.merge(codec.parse(storedText), state);
    const text = codec.serialize(merged);
    if (text !== storedText) writeStorage(key, text);
    // Another tab had saved data this one did not have yet: show it here too
    if (text !== codec.serialize(state)) setState(merged);
  }, [key, codec, state]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // key null: another tab cleared all storage. Keep this tab's data; its next save restores it.
      if (e.key !== key) return;
      const stored = codec.parse(readStorage(key));
      setState(prev => {
        const merged = codec.merge(stored, prev);
        if (codec.serialize(merged) === codec.serialize(prev)) return prev;
        fromOtherTab.current = true;
        return merged;
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key, codec]);

  return [state, setLocal, fromOtherTab];
}
