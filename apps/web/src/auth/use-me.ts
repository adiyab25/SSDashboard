'use client';

import { MeResponse } from '@ssdashboard/contracts';
import { useEffect, useState } from 'react';
import { apiFetch } from './api-fetch';
import { ME_PATH } from './me-path';

/** The answer of each who am I path asked on this page load, keyed by the path. */
const answers = new Map<string, Promise<MeResponse | null>>();

/**
 * `GET /api/me` (or `path`, `/api/partner/me` on the partner pages), fetched once per page load
 * and per path, so the staff and partner answers never stand in for each other. Resolves to null
 * when the call fails or the answer breaks the `MeResponse` contract (a 401 also sends the
 * person to sign in). A failure is not cached: the next caller asks again.
 */
export function loadMe(path: string = ME_PATH.backoffice): Promise<MeResponse | null> {
  const cached = answers.get(path);
  if (cached) return cached;
  const answer: Promise<MeResponse | null> = apiFetch(path, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`api answered ${response.status}`);
      return MeResponse.parse(await response.json());
    })
    .catch(() => {
      // Forget only this failed load, never an answer `setMe` put in its place meanwhile.
      if (answers.get(path) === answer) answers.delete(path);
      return null;
    });
  answers.set(path, answer);
  return answer;
}

/** Where loading the signed in person stands: still loading, loaded, or failed. */
export type MeState =
  { status: 'loading' } | { status: 'ready'; me: MeResponse } | { status: 'failed' };

/**
 * The signed in person with the state of the load, so a page that must show an error instead of
 * loading forever (the account screen) can tell a failure from a load still running. Raising
 * `attempt` loads again (a failure is not cached), which is what a Try again button does.
 */
export function useMeState(path: string = ME_PATH.backoffice, attempt = 0): MeState {
  // The answer is tagged with the attempt it belongs to, so a new attempt reads as loading
  // again without setting state inside the effect.
  const [answer, setAnswer] = useState<{ attempt: number; state: MeState } | null>(null);

  useEffect(() => {
    let active = true;
    void loadMe(path).then((result) => {
      if (!active) return;
      setAnswer({
        attempt,
        state: result ? { status: 'ready', me: result } : { status: 'failed' },
      });
    });
    return () => {
      active = false;
    };
  }, [path, attempt]);

  return answer && answer.attempt === attempt ? answer.state : { status: 'loading' };
}

/** The signed in person, or null while loading and when it could not be loaded. */
export function useMe(path?: string): MeResponse | null {
  const state = useMeState(path);
  return state.status === 'ready' ? state.me : null;
}

/** Replaces the cached answer of `path`, after the person edits their own profile. */
export function setMe(next: MeResponse, path: string = ME_PATH.backoffice): void {
  answers.set(path, Promise.resolve(next));
}

/** Forgets every cached answer, so a test starts from a fresh load. */
export function resetMeForTests(): void {
  answers.clear();
}
