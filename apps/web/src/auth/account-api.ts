import { type Home, MeResponse } from '@ssdashboard/contracts';
import { apiFetch } from './api-fetch';
import { ME_PATH } from './me-path';
import { setMe } from './use-me';

/** The outcome of a profile change: the new person, or the api status and error code. */
export type ProfileResult =
  { ok: true; me: MeResponse } | { ok: false; status: number; code: string };

/**
 * `PATCH` on the signed in person's own route for `audience` (`/api/me` for staff,
 * `/api/partner/me` for a partner user, through `ME_PATH`): the person edits their own name,
 * phone or language (AC-19, AC-28). It must never take a free path, so no caller can aim it at
 * another route.
 */
export async function updateProfile(
  changes: { name?: string; phone?: string; language?: string },
  audience: Home = 'backoffice',
): Promise<ProfileResult> {
  const path = ME_PATH[audience];
  try {
    const response = await apiFetch(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changes),
    });
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const me = MeResponse.parse(json);
      setMe(me, path);
      return { ok: true, me };
    }
    const code =
      typeof json === 'object' && json !== null && 'code' in json && typeof json.code === 'string'
        ? json.code
        : 'generic';
    return { ok: false, status: response.status, code };
  } catch {
    return { ok: false, status: 0, code: 'generic' };
  }
}

/**
 * Choosing a language in the user menu also saves it to the account, so signing in on another
 * device applies it (AC-19). A failure is not shown: the language already changed on this
 * device, and the next choice tries again.
 */
export async function saveLanguageToAccount(code: string): Promise<void> {
  await updateProfile({ language: code });
}
