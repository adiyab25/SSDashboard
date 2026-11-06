'use client';

import { MeResponse } from '@ssdashboard/contracts';
import { useEffect, useState } from 'react';
import { apiFetch } from './api-fetch';
import { ME_PATH } from './me-path';

let me: Promise<MeResponse | null> | undefined;

/**
 * `GET /api/me` (or `path`, `/api/partner/me` on the partner pages), fetched once per page load:
 * a page belongs to one audience, so the first path asked is the one cached. Resolves to null
 * when the call fails (a 401 also sends the person to sign in). A failure is not cached: the
 * next caller asks again.
 */
export function loadMe(path: string = ME_PATH.backoffice): Promise<MeResponse | null> {
  me ??= apiFetch(path, { cache: 'no-store' })
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
export function useMe(path?: string): MeResponse | null {
  const [current, setCurrent] = useState<MeResponse | null>(null);

  useEffect(() => {
    let active = true;
    void loadMe(path).then((result) => {
      if (active) setCurrent(result);
    });
    return () => {
      active = false;
    };
  }, [path]);

  return current;
}

/** Replaces the cached answer, after the person edits their own profile. */
export function setMe(next: MeResponse): void {
  me = Promise.resolve(next);
}

/** Forgets the cached answer, so a test starts from a fresh load. */
export function resetMeForTests(): void {
  me = undefined;
}
