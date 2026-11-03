'use client';

import { Direction } from 'radix-ui';
import { createContext, use, useCallback, useMemo, useSyncExternalStore } from 'react';

export type TextDirection = 'ltr' | 'rtl';

/**
 * Development only, until feature 5 replaces it with the language switch. Inlined at
 * build time, so production builds carry neither the switch nor the head script.
 */
export const DIRECTION_SWITCH = process.env.NODE_ENV !== 'production';

const STORAGE_KEY = 'ss_dir';

/** Runs in `<head>` before first paint so a right to left page never flashes left to right. */
export const directionScript = `try{var d=localStorage.getItem('${STORAGE_KEY}');if(d==='rtl'||d==='ltr')document.documentElement.dir=d}catch(e){}`;

const listeners = new Set<() => void>();

function readStored(): TextDirection {
  if (!DIRECTION_SWITCH) return 'ltr';
  try {
    return localStorage.getItem(STORAGE_KEY) === 'rtl' ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

interface DirectionSetting {
  dir: TextDirection;
  setDir: (dir: TextDirection) => void;
}

const DirectionContext = createContext<DirectionSetting>({ dir: 'ltr', setDir: () => {} });

/**
 * Keeps `<html dir>` and Radix's direction (which every portal reads) in step. Radix
 * never reads `<html dir>`, so both change together, without a reload.
 */
export function DirectionBridge({ children }: { children: React.ReactNode }) {
  const dir = useSyncExternalStore(subscribe, readStored, () => 'ltr' as const);

  const setDir = useCallback((next: TextDirection) => {
    if (!DIRECTION_SWITCH) return;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked: the switch still applies until reload.
    }
    document.documentElement.dir = next;
    for (const listener of listeners) listener();
  }, []);

  const value = useMemo(() => ({ dir, setDir }), [dir, setDir]);

  return (
    <DirectionContext value={value}>
      <Direction.Provider dir={dir}>{children}</Direction.Provider>
    </DirectionContext>
  );
}

export function useDirectionSetting(): DirectionSetting {
  return use(DirectionContext);
}
