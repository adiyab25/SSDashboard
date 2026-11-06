import { MeResponse } from '@ssdashboard/contracts';
import { writeLanguageCookie } from '@/i18n/language-cookie';
import { safeReturnTo } from './return-to';

/** `GET /api/me` and `GET /api/partner/me` answer with the same shape; null on any failure. */
async function readMe(path: string): Promise<{ me: MeResponse | null; wrongAudience: boolean }> {
  const response = await fetch(path, { cache: 'no-store' });
  if (response.ok) {
    const parsed = MeResponse.safeParse(await response.json());
    return { me: parsed.success ? parsed.data : null, wrongAudience: false };
  }
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return { me: null, wrongAudience: response.status === 403 && body?.code === 'WRONG_AUDIENCE' };
}

/**
 * The page a person lands on once they are fully signed in (spec 0005, AC-19, AC-28). It asks
 * `GET /api/me` and, when the api answers 403 `WRONG_AUDIENCE` (a partner session on a staff
 * route), `GET /api/partner/me`; whichever answers gives `home`. A saved account language wins
 * over one chosen on the sign in screen, so it is set through the same function the language
 * switcher uses. The wanted page (`returnTo`) is followed only when it passes `safeReturnTo` for
 * that audience; otherwise the person lands on the audience's home. Any failure, including a
 * missing `/api/partner/me`, is ignored: the person is signed in either way, so they land as
 * back office staff would and keep the language as it is.
 */
export async function finishSignIn(returnTo: string | null, origin: string): Promise<string> {
  let me: MeResponse | null = null;
  try {
    const first = await readMe('/api/me');
    me = first.me;
    if (!me && first.wrongAudience) me = (await readMe('/api/partner/me')).me;
  } catch {
    // keep the current language and the staff landing
  }
  if (me?.language) writeLanguageCookie(me.language);
  return safeReturnTo(returnTo, origin, me?.home ?? 'backoffice');
}
