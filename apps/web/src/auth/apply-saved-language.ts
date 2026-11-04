import { MeResponse } from '@ssdashboard/contracts';
import { writeLanguageCookie } from '@/i18n/language-cookie';

/**
 * After a full sign in, a saved account language wins over one chosen on the sign in screen, so it
 * is set through the same function the language switcher uses (spec 0005, AC-19). Any failure is
 * ignored: the person is signed in either way, and the language just stays as it is.
 */
export async function applySavedLanguage(): Promise<void> {
  try {
    const response = await fetch('/api/me', { cache: 'no-store' });
    if (!response.ok) return;
    const me = MeResponse.safeParse(await response.json());
    if (me.success && me.data.language) writeLanguageCookie(me.data.language);
  } catch {
    // keep the current language
  }
}
