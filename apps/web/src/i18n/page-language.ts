import { notFound } from 'next/navigation';
import type { CoreLanguage } from '@ssdashboard/i18n';
import { matchPublicLanguage } from './public-language';
import { rootLanguage } from './root-language';

/**
 * The language of the current portal or partner page, from the `lang` root parameter. A value
 * other than `en` or `ar` is a 404. Server components only; it must never be used in the back
 * office, where there is no `lang` parameter.
 */
export async function pageLanguage(): Promise<CoreLanguage> {
  const language = matchPublicLanguage(await rootLanguage());
  if (!language) notFound();
  return language;
}
