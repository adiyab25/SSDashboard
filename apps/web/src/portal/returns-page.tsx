import { createTranslatorSync, type CoreLanguage } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { PortalFrame } from '@ssdashboard/ui/frames/portal-frame';
import { OtherLanguageLink } from '@/i18n/other-language-link';

/**
 * Placeholder for the public exchange and return portal (spec 0007, section 2), inside the
 * `PortalFrame` (spec 0003, AC-18). A server component: the text is rendered on the server in the
 * page's language (spec 0004, AC-16). There is no brand settings endpoint yet, so the frame shows
 * the neutral primary and the install's fallback name; it must never call a staff api route.
 */
export function ReturnsPage({ language }: { language: CoreLanguage }) {
  const { t } = createTranslatorSync(language, { ar });

  return (
    <PortalFrame
      brand={{ name: t('shell.clientNameFallback') }}
      title={t('portal.returns.title')}
      languageSwitch={<OtherLanguageLink language={language} path="/returns" />}
    >
      <p className="text-muted-foreground">{t('portal.returns.description')}</p>
    </PortalFrame>
  );
}
