import { MeResponse } from '@ssdashboard/contracts';
import { apiFetch } from './api-fetch';
import { setMe } from './use-me';

/** The outcome of a profile change: the new person, or the api status and error code. */
export type ProfileResult =
  { ok: true; me: MeResponse } | { ok: false; status: number; code: string };

/** `PATCH /api/me`: the signed in person edits their own name, phone or language (AC-19). */
export async function updateProfile(changes: {
  name?: string;
  phone?: string;
  language?: string;
}): Promise<ProfileResult> {
  try {
    const response = await apiFetch('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changes),
    });
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const me = MeResponse.parse(json);
      setMe(me);
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
