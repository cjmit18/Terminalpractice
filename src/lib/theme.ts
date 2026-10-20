import { useCallback, useEffect, useState } from 'react';
import { readStorage, writeStorage } from './storage';

/** "system" follows the OS. It is stored as the absence of the key. */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'certsim:theme';

export function loadTheme(): ThemeChoice {
  const saved = readStorage(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [theme, setThemeState] = useState<ThemeChoice>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((choice: ThemeChoice) => {
    writeStorage(THEME_KEY, choice === 'system' ? null : choice);
    setThemeState(choice);
  }, []);

  return [theme, setTheme];
}
