import type { Metadata } from 'next';
import { createTranslatorSync } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { matchPublicLanguage } from '@/i18n/public-language';
import { rootLanguage } from '@/i18n/root-language';

/**
 * Title and description of the portal and partner documents, in the URL's language, with a
 * product neutral description instead of the staff one. A segment other than `en` or `ar` gets
 * English (the page itself is a 404). It must never read cookies or headers.
 */
export async function publicMetadata(): Promise<Metadata> {
  const language = matchPublicLanguage(await rootLanguage()) ?? 'en';
  const { t } = createTranslatorSync(language, language === 'ar' ? { ar } : {});
  return { title: 'SSDashboard', description: t('shell.publicDescription') };
}
