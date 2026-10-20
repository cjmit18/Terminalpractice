import { SystemState } from '../types/terminal';

/** Copies a SystemState so engines can work on it without touching the caller's object. */
export function cloneState(state: SystemState): SystemState {
  return { ...state };
}
