'use client';

import { MeResponse } from '@ssdashboard/contracts';
import { useEffect, useState } from 'react';
import { apiFetch } from './api-fetch';

let me: Promise<MeResponse | null> | undefined;

/**
 * `GET /api/me`, fetched once per page load. Resolves to null when the call fails (a 401 also
 * sends the person to sign in). A failure is not cached: the next caller asks again.
 */
export function loadMe(): Promise<MeResponse | null> {
  me ??= apiFetch('/api/me', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`api answered ${response.status}`);
      return MeResponse.parse(await response.json());
    })
    .catch(() => {
      me = undefined;
      return null;
    });
  return me;
}

/** The signed in person, or null while loading and when it could not be loaded. */
export function useMe(): MeResponse | null {
  const [current, setCurrent] = useState<MeResponse | null>(null);

  useEffect(() => {
    let active = true;
    void loadMe().then((result) => {
      if (active) setCurrent(result);
    });
    return () => {
      active = false;
    };
  }, []);

  return current;
}

/** Forgets the cached answer, so a test starts from a fresh load. */
export function resetMeForTests(): void {
  me = undefined;
}
