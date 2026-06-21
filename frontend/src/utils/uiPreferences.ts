import { useSyncExternalStore } from 'react';

const MINI_MAP_ENABLED_KEY = 'megaform-mini-map-enabled';
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMiniMapEnabled() {
  return localStorage.getItem(MINI_MAP_ENABLED_KEY) !== 'false';
}

export function setMiniMapEnabled(enabled: boolean) {
  localStorage.setItem(MINI_MAP_ENABLED_KEY, String(enabled));
  emit();
}

export function useMiniMapEnabled() {
  return useSyncExternalStore(subscribe, getMiniMapEnabled, () => true);
}
