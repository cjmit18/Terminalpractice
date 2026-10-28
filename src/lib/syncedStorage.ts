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
 * The codec must be stable (create it once, outside the component). The key may change (signing in
 * switches to the account's keys): the state is then read again from the new key, and nothing is
 * written there until this tab changes something.
 */
export function useSyncedStorage<T>(key: string, codec: SyncedCodec<T>): [T, Dispatch<SetStateAction<T>>, MutableRefObject<boolean>] {
  // The key the state belongs to, the state, and the value read on load (saving that back would
  // change nothing this tab did)
  const [slot, setSlot] = useState(() => {
    const value = codec.parse(readStorage(key));
    return { key, value, loaded: value };
  });
  let active = slot;
  if (slot.key !== key) {
    const value = codec.parse(readStorage(key));
    active = { key, value, loaded: value };
    setSlot(active);
  }
  const state = active.value;
  const fromOtherTab = useRef(false);
  const setState = useCallback((value: SetStateAction<T>) => {
    setSlot(s => {
      const next = typeof value === 'function' ? (value as (prev: T) => T)(s.value) : value;
      return next === s.value ? s : { ...s, value: next };
    });
  }, []);
  const setLocal = useCallback<Dispatch<SetStateAction<T>>>(
    value => {
      fromOtherTab.current = false;
      setState(value);
    },
    [setState],
  );

  useEffect(() => {
    if (slot.key !== key || slot.value === slot.loaded) return;
    const storedText = readStorage(key);
    const merged = codec.merge(codec.parse(storedText), slot.value);
    const text = codec.serialize(merged);
    if (text !== storedText) writeStorage(key, text);
    // Another tab had saved data this one did not have yet: show it here too
    if (text !== codec.serialize(slot.value)) setState(merged);
  }, [key, codec, slot, setState]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // key null: another tab cleared all storage. Keep this tab's data; its next save restores it.
      if (e.key !== key) return;
      const stored = codec.parse(readStorage(key));
      setSlot(s => {
        if (s.key !== key) return s;
        const merged = codec.merge(stored, s.value);
        if (codec.serialize(merged) === codec.serialize(s.value)) return s;
        fromOtherTab.current = true;
        return { ...s, value: merged };
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key, codec]);

  return [state, setLocal, fromOtherTab];
}
