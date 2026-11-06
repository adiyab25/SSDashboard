import { type Home, MeResponse } from '@ssdashboard/contracts';
import { writeLanguageCookie } from '@/i18n/language-cookie';
import { ME_PATH } from './me-path';
import { changePasswordUrl, safeReturnTo } from './return-to';

/** `GET /api/me` and `GET /api/partner/me` answer with the same shape; null on any failure. */
async function readMe(path: string): Promise<{ me: MeResponse | null; wrongAudience: boolean }> {
  const response = await fetch(path, { cache: 'no-store' });
  if (response.ok) {
    const parsed = MeResponse.safeParse(await response.json().catch(() => null));
    return { me: parsed.success ? parsed.data : null, wrongAudience: false };
  }
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return { me: null, wrongAudience: response.status === 403 && body?.code === 'WRONG_AUDIENCE' };
}

/**
 * The page a person lands on once they are fully signed in (spec 0005, AC-14, AC-19, AC-28). It
 * asks `GET /api/me` and, when the api answers 403 `WRONG_AUDIENCE` (a partner session on a staff
 * route), `GET /api/partner/me`; whichever answers gives `home`. A saved account language wins
 * over one chosen on the sign in screen, so it is set through the same function the language
 * switcher uses. The wanted page (`returnTo`) is followed only when it passes `safeReturnTo` for
 * that audience; otherwise the person lands on the audience's home. A person who must still
 * change a temporary password goes to the change password page first, carrying the landing as
 * its `returnTo`. Any failure is ignored, because the person is signed in either way: once the
 * api said `WRONG_AUDIENCE` the person is not staff, so they land on the partner home even when
 * `/api/partner/me` then fails; otherwise they land as back office staff would. It must never
 * land a person in another audience's pages.
 */
export async function finishSignIn(returnTo: string | null, origin: string): Promise<string> {
  let me: MeResponse | null = null;
  let home: Home = 'backoffice';
  try {
    const first = await readMe(ME_PATH.backoffice);
    me = first.me;
    if (!me && first.wrongAudience) {
      home = 'partner';
      me = (await readMe(ME_PATH.partner)).me;
    }
  } catch {
    // keep the current language and the landing chosen so far
  }
  if (me?.language) writeLanguageCookie(me.language);
  const landing = safeReturnTo(returnTo, origin, me?.home ?? home);
  return me?.mustChangePassword ? changePasswordUrl(landing) : landing;
}
