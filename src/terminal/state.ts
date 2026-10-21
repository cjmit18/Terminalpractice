import { SystemState } from '../types/terminal';

/**
 * Deep-copies a SystemState so engines can work on it without touching the caller's object.
 * Labs share nested arrays (services, disks, AD users) between modules, so a shallow copy
 * is not enough: Start-Service or diskpart would otherwise edit module.initialState.
 */
export function cloneState(state: SystemState): SystemState {
  return structuredClone(state);
}
