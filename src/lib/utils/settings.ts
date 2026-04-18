import { STORAGE_KEYS } from '../constants';

export function readSettingsStorage(): { alwaysExpandThinking?: boolean } | null {
  const raw = window.localStorage.getItem(STORAGE_KEYS.SETTINGS);
  return raw ? JSON.parse(raw) : null;
}

export function writeSettingsStorage(value: { alwaysExpandThinking: boolean }): void {
  window.localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(value));
}
